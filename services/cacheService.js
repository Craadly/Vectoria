// services/cacheService.js
'use strict';

/**
 * Simple in-process caching with TTL + LRU eviction.
 *
 * What it caches:
 *  - Prompt enhancements      → promptCache
 *  - Raster generations/SVGs  → imageCache (by a stable key you build)
 *
 * Key features:
 *  - TTL-based freshness (maxAge)
 *  - True LRU semantics (recent gets bump recency)
 *  - Lightweight (no deps); optional background pruner
 *  - Safe helpers to generate stable keys (SHA-1)
 *  - Memoizers for common calls (enhancePrompt, generateImage)
 *
 * Usage:
 *   const cache = require('./cacheService');
 *
 *   // Prompt enhancement
 *   const hit = cache.getCachedPromptEnhancement(prompt);
 *   if (!hit) {
 *     const enhanced = await gemini.enhancePrompt(prompt);
 *     cache.setCachedPromptEnhancement(prompt, enhanced);
 *   }
 *
 *   // Image cache (keyed by prompt + params)
 *   const key = cache.makeImageKey({ prompt: enhancedPrompt, model: 'imagen-4.0', size: 1024 });
 *   let img = cache.getImage(key);
 *   if (!img) {
 *     img = await imagen.generateImage(enhancedPrompt);
 *     cache.setImage(key, img, { keepBuffer: false }); // avoid storing big Buffers by default
 *   }
 *
 *   // Optional background pruning
 *   cache.startPruner(); // call once at app boot
 */

const crypto = require('crypto');

class LRUCache {
  /**
   * @param {{ maxItems?: number, maxAge?: number }} opts
   */
  constructor(opts = {}) {
    this.maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 1000;
    this.maxAge   = Number.isFinite(opts.maxAge) ? opts.maxAge : 60 * 60 * 1000; // 1h
    this.map      = new Map(); // key -> { value, ts }
  }

  _now() { return Date.now(); }
  _fresh(entry) {
    if (!entry) return false;
    if (this.maxAge <= 0) return true;
    return (this._now() - entry.ts) < this.maxAge;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (!this._fresh(e)) {
      this.map.delete(key);
      return null;
    }
    // bump recency
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key, value) {
    const e = { value, ts: this._now() };
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, e);
    this._evictIfNeeded();
    return value;
  }

  _evictIfNeeded() {
    while (this.maxItems > 0 && this.map.size > this.maxItems) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }

  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }

  pruneExpired() {
    if (this.maxAge <= 0) return 0;
    const now = this._now();
    let removed = 0;
    for (const [k, e] of this.map) {
      if ((now - e.ts) >= this.maxAge) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }

  size() { return this.map.size; }

  stats() {
    return {
      size: this.size(),
      maxItems: this.maxItems,
      maxAgeMs: this.maxAge,
    };
  }
}

class CacheService {
  /**
   * @param {{ maxAge?: number, promptMaxItems?: number, imageMaxItems?: number, prunerIntervalMs?: number }} opts
   */
  constructor(opts = {}) {
    const maxAge = Number.isFinite(opts.maxAge) ? opts.maxAge : 60 * 60 * 1000; // 1h
    const promptMaxItems = Number.isFinite(opts.promptMaxItems) ? opts.promptMaxItems : 1000;
    const imageMaxItems  = Number.isFinite(opts.imageMaxItems) ? opts.imageMaxItems : 500;

    this.promptCache = new LRUCache({ maxItems: promptMaxItems, maxAge });
    this.imageCache  = new LRUCache({ maxItems: imageMaxItems,  maxAge });

    this._prunerIntervalMs = Number.isFinite(opts.prunerIntervalMs) ? opts.prunerIntervalMs : 5 * 60 * 1000; // 5m
    this._prunerHandle = null;
  }

  // ---------- Key helpers ----------
  normalizePrompt(prompt) {
    // Keep content as-is to preserve meaning; just trim outer whitespace
    return String(prompt ?? '').trim();
  }

  /**
   * Build a stable key for image cache from arbitrary props.
   * Prefer using fields like: { prompt, model, size, style, aspectRatio, negPrompt }
   */
  makeImageKey(obj) {
    const json = JSON.stringify(obj || {});
    return crypto.createHash('sha1').update(json).digest('hex');
  }

  // ---------- Prompt enhancement cache ----------
  getCachedPromptEnhancement(prompt) {
    const key = this.normalizePrompt(prompt);
    return this.promptCache.get(key);
  }

  setCachedPromptEnhancement(prompt, enhanced) {
    const key = this.normalizePrompt(prompt);
    const value = String(enhanced ?? '');
    this.promptCache.set(key, value);
    return value;
  }

  // ---------- Image cache ----------
  /**
   * Store an image result. By default we avoid keeping large Buffers in memory.
   * @param {string} key - stable key (e.g., from makeImageKey)
   * @param {{ imageUrl?:string, imagePath?:string, imageBuffer?:Buffer, svgCode?:string, svgUrl?:string }} data
   * @param {{ keepBuffer?: boolean }} opts
   */
  setImage(key, data, opts = {}) {
    const keepBuffer = !!opts.keepBuffer;
    const payload = {
      imageUrl:  data.imageUrl || null,
      imagePath: data.imagePath || null,
      svgUrl:    data.svgUrl   || null,
      svgCode:   typeof data.svgCode === 'string' ? data.svgCode : null,
      // Store small buffers only (or if explicitly asked)
      imageBuffer: keepBuffer && data.imageBuffer
        ? (data.imageBuffer.length <= (256 * 1024) ? data.imageBuffer : undefined)
        : undefined,
      bufferLen:  data.imageBuffer ? data.imageBuffer.length : 0,
    };
    this.imageCache.set(key, payload);
    return payload;
  }

  /**
   * Retrieve an image record.
   * @param {string} key
   * @returns {{ imageUrl?:string, imagePath?:string, imageBuffer?:Buffer, svgCode?:string, svgUrl?:string, bufferLen?:number } | null}
   */
  getImage(key) {
    return this.imageCache.get(key);
  }

  // ---------- Memoizers ----------
  /**
   * Memoize a prompt enhancement function: (prompt) => Promise<string>
   * First checks cache; on success stores result.
   */
  enhancePromptMemo(fn) {
    if (typeof fn !== 'function') throw new TypeError('enhancePromptMemo expects a function.');
    return async (prompt) => {
      const hit = this.getCachedPromptEnhancement(prompt);
      if (hit) return hit;
      const out = await fn(prompt);
      this.setCachedPromptEnhancement(prompt, out);
      return out;
    };
  }

  /**
   * Memoize an image-generation function: (enhancedPrompt) => Promise<{imageUrl, imagePath, imageBuffer?}>
   * Uses a stable key built from prompt + optional params.
   */
  generateImageMemo(fn, { params = {}, keepBuffer = false } = {}) {
    if (typeof fn !== 'function') throw new TypeError('generateImageMemo expects a function.');
    return async (enhancedPrompt) => {
      const key = this.makeImageKey({ prompt: enhancedPrompt, ...params });
      const hit = this.getImage(key);
      if (hit) return hit;
      const out = await fn(enhancedPrompt);
      return this.setImage(key, out, { keepBuffer });
    };
  }

  // ---------- Housekeeping ----------
  prune() {
    const p = this.promptCache.pruneExpired();
    const i = this.imageCache.pruneExpired();
    return { removedPromptEntries: p, removedImageEntries: i };
  }

  startPruner() {
    if (this._prunerHandle) return;
    this._prunerHandle = setInterval(() => {
      const r = this.prune();
      if ((r.removedPromptEntries + r.removedImageEntries) > 0) {
        // Log light touch; keep noise minimal
        // console.log(`[cache] pruned ${r.removedPromptEntries + r.removedImageEntries} expired entries`);
      }
    }, this._prunerIntervalMs);
    this._prunerHandle.unref?.();
  }

  stopPruner() {
    if (this._prunerHandle) {
      clearInterval(this._prunerHandle);
      this._prunerHandle = null;
    }
  }

  clearAll() {
    this.promptCache.clear();
    this.imageCache.clear();
  }

  stats() {
    return {
      prompt: this.promptCache.stats(),
      image:  this.imageCache.stats(),
    };
  }
}

// Singleton export (sufficient for one Node process)
const cacheService = new CacheService({
  maxAge: 60 * 60 * 1000,      // 1 hour TTL
  promptMaxItems: 1000,
  imageMaxItems: 500,
  prunerIntervalMs: 5 * 60 * 1000,
});

module.exports = cacheService;
module.exports.CacheService = CacheService;
module.exports.LRUCache = LRUCache;
