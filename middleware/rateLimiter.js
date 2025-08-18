// middleware/rateLimiter.js
'use strict';

/**
 * Advanced sliding-window rate limiter.
 *
 * - Uses Redis sorted sets (ZSET) for true sliding-window limiting
 * - Falls back to an in-memory window if Redis is unavailable
 * - Per-request headers (both RFC & legacy):
 *     RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
 *     X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *     Retry-After (when limited)
 * - Configurable keying (default: req.ip), window, and limits
 * - Graceful Redis errors (no hard 500s)
 *
 * Usage (Express):
 *   const rateLimiter = createRateLimiter({
 *     windowMs: 60_000,
 *     maxRequests: 30,
 *     keyPrefix: 'rl:',
 *     keyResolver: (req) => req.headers['x-api-key'] || req.ip,
 *     allow: (req) => false, // return true to skip rate limiting (e.g., health checks)
 *   });
 *   app.use('/api', rateLimiter.middleware);
 */

const Redis = require('ioredis');

function createRedisClientFromEnv() {
  const url = process.env.REDIS_URL || '';
  if (!url) return null;

  // ioredis accepts URL directly (redis:// / rediss://)
  const client = new Redis(url, {
    // reasonable defaults
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: false, // connect immediately
  });

  client.on('error', (err) => {
    // Log once per error; don't throw
    console.error('[rateLimiter] Redis error:', err?.message || err);
  });

  return client;
}

class AdvancedRateLimiter {
  /**
   * @param {object} options
   * @param {number} [options.windowMs=60000]      Sliding window size in ms
   * @param {number} [options.maxRequests=30]      Max requests allowed per window
   * @param {string} [options.keyPrefix='rl:']     Redis key prefix
   * @param {(req: any) => string} [options.keyResolver]  Return the bucket key (default: req.ip)
   * @param {(req: any) => boolean} [options.allow]       Return true to bypass limiting for a request
   * @param {Redis}  [options.redis]                Optional existing ioredis client
   */
  constructor(options = {}) {
    this.windowMs    = options.windowMs || 60_000;
    this.maxRequests = options.maxRequests || 30;
    this.keyPrefix   = options.keyPrefix || 'rl:';
    this.keyResolver = typeof options.keyResolver === 'function' ? options.keyResolver : (req) => req.ip || 'unknown';
    this.allow       = typeof options.allow === 'function' ? options.allow : () => false;

    this.redis = options.redis || createRedisClientFromEnv();

    // In-memory fallback store: Map<key, number[]> of timestamps (ms)
    this.memory = new Map();

    // Pre-bound middleware for Express usage
    this.middleware = this.middleware.bind(this);
  }

  // ------------------ Internal helpers ------------------

  _headers(res, { limit, remaining, resetSec }) {
    // Standard headers (RFC 6585 / 9239 style)
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, remaining));
    res.setHeader('RateLimit-Reset', resetSec);

    // Legacy "X-" headers for broader client compatibility
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
    res.setHeader('X-RateLimit-Reset', resetSec);
  }

  _now() {
    return Date.now();
  }

  _calcResetSec(now, oldestTsInWindow) {
    // When sliding window is full, reset = time until the oldest element leaves the window
    const ms = Math.max(0, (oldestTsInWindow + this.windowMs) - now);
    return Math.ceil(ms / 1000);
  }

  // ------------------ Redis path ------------------

  async _hitRedis(key) {
    const now = this._now();
    const windowStart = now - this.windowMs;
    const redisKey = `${this.keyPrefix}${key}`;

    // We use a pipeline to:
    //   1) Remove old entries
    //   2) Add a new entry with current timestamp as score & member
    //   3) Get current cardinality
    //   4) Get the oldest entry (to compute reset)
    //   5) Set TTL (best-effort)
    const pipe = this.redis.pipeline();
    pipe.zremrangebyscore(redisKey, '-inf', windowStart);
    pipe.zadd(redisKey, now, `${now}-${Math.random()}`); // unique member to avoid score/member collisions
    pipe.zcard(redisKey);
    pipe.zrange(redisKey, 0, 0, 'WITHSCORES');
    pipe.expire(redisKey, Math.ceil(this.windowMs / 1000));
    const results = await pipe.exec();

    // Parse results
    // results = [[err, remCount], [err, 'OK'|1], [err, count], [err, [member, score]], [err, ttlSet?]]
    const count = Number(results?.[2]?.[1] || 0);
    const oldestArr = results?.[3]?.[1] || [];
    const oldestScore = oldestArr.length >= 2 ? Number(oldestArr[1]) : now;

    return {
      count,
      oldestScore,
      now,
      windowMs: this.windowMs,
    };
  }

  // ------------------ Memory fallback path ------------------

  _hitMemory(key) {
    const now = this._now();
    const windowStart = now - this.windowMs;

    let arr = this.memory.get(key);
    if (!arr) {
      arr = [];
      this.memory.set(key, arr);
    }

    // Remove old entries
    let i = 0;
    while (i < arr.length && arr[i] <= windowStart) i++;
    if (i > 0) arr.splice(0, i);

    // Add current
    arr.push(now);

    const count = arr.length;
    const oldestScore = arr[0] || now;

    // Keep memory map small by removing empty buckets occasionally
    if (count === 0) this.memory.delete(key);

    return { count, oldestScore, now, windowMs: this.windowMs };
  }

  // ------------------ Middleware ------------------

  /**
   * Express/Koa-compatible middleware
   */
  async middleware(req, res, next) {
    try {
      if (this.allow(req)) return next();

      // Derive key (consider setting app.set('trust proxy', true) if using proxies)
      const key = this.keyResolver(req) || req.ip || 'unknown';

      let snapshot;
      if (this.redis && this.redis.status === 'ready') {
        // Redis path
        try {
          snapshot = await this._hitRedis(key);
        } catch (e) {
          // On Redis failure, degrade to memory without 500s
          console.warn('[rateLimiter] Redis path failed, falling back to memory:', e?.message || e);
          snapshot = this._hitMemory(key);
        }
      } else if (this.redis && this.redis.status === 'connecting') {
        // If still connecting, be permissive and use memory for now
        snapshot = this._hitMemory(key);
      } else {
        // No Redis configured
        snapshot = this._hitMemory(key);
      }

      const { count, oldestScore, now } = snapshot;
      const resetSec = this._calcResetSec(now, oldestScore);

      // Set headers for every response
      const remaining = Math.max(0, this.maxRequests - count);
      this._headers(res, {
        limit: this.maxRequests,
        remaining,
        resetSec,
      });

      if (count > this.maxRequests) {
        // Too many requests
        res.setHeader('Retry-After', resetSec);
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: resetSec,
        });
      }

      return next();
    } catch (err) {
      // Never fail closed on limiter errors; log and continue
      console.error('[rateLimiter] Unexpected error:', err?.message || err);
      return next();
    }
  }
}

// Factory helper for convenience
function createRateLimiter(options) {
  return new AdvancedRateLimiter(options);
}

module.exports = {
  AdvancedRateLimiter,
  createRateLimiter,
};
