// utils/metrics.js
'use strict';

/**
 * Lightweight, dependency-free metrics collector.
 *
 * What you get:
 *  - Request counters + latency histogram
 *  - Per-service counters + latency histogram (gemini, imagen, recraft)
 *  - Recraft credit tracking (remaining + lastCheck)
 *  - Simple timers (startTimer/stop to ms)
 *  - JSON snapshot (getMetrics)
 *  - Prometheus text exposition (toPrometheus)
 *  - Optional Express middleware (metricsMiddleware)
 *
 * Usage:
 *   const metrics = require('../utils/metrics');
 *   const stop = metrics.startTimer();           // returns () => ms
 *   // ... do work ...
 *   const ms = stop();
 *   metrics.recordServiceCall('imagen', ms, true);
 *
 *   // Express:
 *   app.use(metrics.metricsMiddleware());        // records per-request metrics
 *   app.get('/metrics', (req,res)=> {
 *     res.type('text/plain').send(metrics.toPrometheus());
 *   });
 */

const SERVICES = /** @type {const} */ (['gemini', 'imagen', 'recraft']);

// Fixed histogram buckets in milliseconds (Prometheus style "le" buckets)
const DEFAULT_BUCKETS_MS = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];

function hrNow() { return process.hrtime.bigint(); }
function hrElapsedMs(startNs) {
  return Number((process.hrtime.bigint() - startNs) / 1_000_000n);
}

function makeHistogram(bucketsMs = DEFAULT_BUCKETS_MS) {
  return {
    buckets: bucketsMs.slice().sort((a, b) => a - b),
    counts:  new Array(bucketsMs.length).fill(0),
    sumMs:   0,
    count:   0,
  };
}

function observe(hist, valueMs) {
  hist.count += 1;
  hist.sumMs += valueMs;
  for (let i = 0; i < hist.buckets.length; i++) {
    if (valueMs <= hist.buckets[i]) {
      hist.counts[i] += 1;
      return;
    }
  }
  // implicit +Inf bucket: not stored as separate bucket; derived in Prom text.
}

function cloneHistogram(hist) {
  return {
    buckets: hist.buckets.slice(),
    counts:  hist.counts.slice(),
    sumMs:   hist.sumMs,
    count:   hist.count,
  };
}

class MetricsCollector {
  /**
   * @param {{buckets?: number[]}} [opts]
   */
  constructor(opts = {}) {
    const buckets = opts.buckets || DEFAULT_BUCKETS_MS;

    this.metrics = {
      requests: {
        total: 0,
        success: 0,
        failed: 0,
        histogram: makeHistogram(buckets),
      },
      services: {
        gemini:  { calls: 0, errors: 0, avgLatency: 0, histogram: makeHistogram(buckets) },
        imagen:  { calls: 0, errors: 0, avgLatency: 0, histogram: makeHistogram(buckets) },
        recraft: { calls: 0, errors: 0, avgLatency: 0, histogram: makeHistogram(buckets) },
      },
      credits: {
        recraft: { remaining: null, lastCheck: null },
      },
      startTime: new Date().toISOString(),
    };
  }

  // ---------- Timers ----------
  /**
   * Start a high-resolution timer.
   * @returns {() => number} stop() -> elapsed ms
   */
  startTimer() {
    const start = hrNow();
    return () => hrElapsedMs(start);
  }

  // ---------- Requests ----------
  /**
   * Record one HTTP request result.
   * @param {number} latencyMs
   * @param {boolean} success
   */
  recordRequest(latencyMs, success) {
    const reqs = this.metrics.requests;
    reqs.total += 1;
    if (success) reqs.success += 1;
    else reqs.failed += 1;
    observe(reqs.histogram, latencyMs);
  }

  // ---------- Services ----------
  /**
   * Record a service call (gemini | imagen | recraft).
   * @param {'gemini'|'imagen'|'recraft'} service
   * @param {number} latencyMs
   * @param {boolean} success
   */
  recordServiceCall(service, latencyMs, success) {
    if (!SERVICES.includes(service)) return;
    const s = this.metrics.services[service];
    s.calls += 1;
    if (!success) s.errors += 1;
    // rolling average
    s.avgLatency = ((s.avgLatency * (s.calls - 1)) + latencyMs) / s.calls;
    observe(s.histogram, latencyMs);
  }

  /**
   * Update recraft credit info (number or null).
   * @param {number|null} remaining
   */
  recordRecraftCredits(remaining) {
    this.metrics.credits.recraft.remaining = remaining;
    this.metrics.credits.recraft.lastCheck = new Date().toISOString();
  }

  // ---------- Snapshot ----------
  /**
   * Return a JSON-safe snapshot of metrics.
   */
  getMetrics() {
    const m = this.metrics;
    return {
      timestamp: new Date().toISOString(),
      startTime: m.startTime,
      requests: {
        total: m.requests.total,
        success: m.requests.success,
        failed: m.requests.failed,
        histogram: cloneHistogram(m.requests.histogram),
      },
      services: {
        gemini: {
          calls: m.services.gemini.calls,
          errors: m.services.gemini.errors,
          avgLatency: Number(m.services.gemini.avgLatency.toFixed(3)),
          histogram: cloneHistogram(m.services.gemini.histogram),
        },
        imagen: {
          calls: m.services.imagen.calls,
          errors: m.services.imagen.errors,
          avgLatency: Number(m.services.imagen.avgLatency.toFixed(3)),
          histogram: cloneHistogram(m.services.imagen.histogram),
        },
        recraft: {
          calls: m.services.recraft.calls,
          errors: m.services.recraft.errors,
          avgLatency: Number(m.services.recraft.avgLatency.toFixed(3)),
          histogram: cloneHistogram(m.services.recraft.histogram),
        },
      },
      credits: {
        recraft: { ...this.metrics.credits.recraft },
      },
    };
  }

  // ---------- Prometheus exposition ----------
  /**
   * Produce Prometheus text format (OpenMetrics-ish) without external deps.
   * Metrics:
   *  - app_requests_total{status}
   *  - app_request_duration_ms_bucket{le}
   *  - app_request_duration_ms_sum
   *  - app_request_duration_ms_count
   *  - app_service_calls_total{service}
   *  - app_service_errors_total{service}
   *  - app_service_duration_ms_bucket{service,le}
   *  - app_service_duration_ms_sum{service}
   *  - app_service_duration_ms_count{service}
   *  - app_recraft_credits_remaining
   */
  toPrometheus() {
    const lines = [];
    const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Requests counters
    lines.push('# HELP app_requests_total Total HTTP requests');
    lines.push('# TYPE app_requests_total counter');
    lines.push(`app_requests_total{status="success"} ${this.metrics.requests.success}`);
    lines.push(`app_requests_total{status="failed"} ${this.metrics.requests.failed}`);
    lines.push(`app_requests_total{status="total"} ${this.metrics.requests.total}`);

    // Request histogram
    const rh = this.metrics.requests.histogram;
    lines.push('# HELP app_request_duration_ms Request duration in milliseconds');
    lines.push('# TYPE app_request_duration_ms histogram');

    // cumulative buckets
    let cumulative = 0;
    for (let i = 0; i < rh.buckets.length; i++) {
      cumulative += rh.counts[i];
      lines.push(`app_request_duration_ms_bucket{le="${rh.buckets[i]}"} ${cumulative}`);
    }
    // +Inf bucket
    lines.push(`app_request_duration_ms_bucket{le="+Inf"} ${rh.count}`);

    lines.push(`app_request_duration_ms_sum ${rh.sumMs.toFixed(3)}`);
    lines.push(`app_request_duration_ms_count ${rh.count}`);

    // Per-service metrics
    for (const svc of SERVICES) {
      const s = this.metrics.services[svc];

      lines.push('# HELP app_service_calls_total Total service calls');
      lines.push('# TYPE app_service_calls_total counter');
      lines.push(`app_service_calls_total{service="${esc(svc)}"} ${s.calls}`);

      lines.push('# HELP app_service_errors_total Total service call errors');
      lines.push('# TYPE app_service_errors_total counter');
      lines.push(`app_service_errors_total{service="${esc(svc)}"} ${s.errors}`);

      const sh = s.histogram;
      lines.push('# HELP app_service_duration_ms Service call duration in milliseconds');
      lines.push('# TYPE app_service_duration_ms histogram');

      let svcCum = 0;
      for (let i = 0; i < sh.buckets.length; i++) {
        svcCum += sh.counts[i];
        lines.push(`app_service_duration_ms_bucket{service="${esc(svc)}",le="${sh.buckets[i]}"} ${svcCum}`);
      }
      lines.push(`app_service_duration_ms_bucket{service="${esc(svc)}",le="+Inf"} ${sh.count}`);
      lines.push(`app_service_duration_ms_sum{service="${esc(svc)}"} ${sh.sumMs.toFixed(3)}`);
      lines.push(`app_service_duration_ms_count{service="${esc(svc)}"} ${sh.count}`);
    }

    // Recraft credits (gauge)
    const credits = this.metrics.credits.recraft.remaining;
    if (credits !== null && credits !== undefined && !Number.isNaN(credits)) {
      lines.push('# HELP app_recraft_credits_remaining Remaining Recraft credits');
      lines.push('# TYPE app_recraft_credits_remaining gauge');
      lines.push(`app_recraft_credits_remaining ${Number(credits)}`);
    }

    return lines.join('\n') + '\n';
  }

  // ---------- Express middleware ----------
  /**
   * Express/Koa-style middleware that records per-request metrics.
   * - Success = status < 400
   * - Uses req.path (if available) only for debug logging; metrics are global.
   */
  metricsMiddleware() {
    return (req, res, next) => {
      const stop = this.startTimer();

      const done = () => {
        res.removeListener('finish', done);
        res.removeListener('close', done);
        const ms = stop();
        const success = typeof res.statusCode === 'number' ? res.statusCode < 400 : true;
        this.recordRequest(ms, success);
      };

      res.on('finish', done);
      res.on('close', done);
      next();
    };
  }
}

// Singleton (good enough for a single Node process)
const metrics = new MetricsCollector();

module.exports = metrics;
module.exports.MetricsCollector = MetricsCollector;
