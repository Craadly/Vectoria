// controllers/generationController.js
'use strict';

/**
 * SVG generation controller with a graceful, layered degradation chain.
 *
 * Strategies (in order):
 *   1) primary         → Enhance (Gemini) → Raster (Imagen) → Vectorize (Recraft)
 *   2) gemini_direct   → Direct SVG from Gemini (no raster step)
 *   3) local_potrace   → If we already have a raster, vectorize locally (potrace)
 *   4) raster_only     → Return raster-only with an explanatory message
 *   5) emergency_fallback → Generate simple SVG locally
 *
 * Notes:
 * - Preserves the response shape used by the client.
 * - Provides correlationId + per-step timings (enable with ?debug=1 or x-debug:1).
 * - Uses strict, explicit fallbacks without repeating expensive upstream calls.
 */

const crypto = require('crypto');

const config = require('../config/env');
const { nowNs, msSince } = require('./strategies/utils');
const primaryPipeline = require('./strategies/primaryPipeline');
const geminiDirectStrategy = require('./strategies/geminiDirectStrategy');
const localPotraceStrategy = require('./strategies/localPotraceStrategy');
const rasterOnlyStrategy = require('./strategies/rasterOnlyStrategy');
const emergencyFallbackStrategy = require('./strategies/emergencyFallbackStrategy');


// ---------------- Tunables ----------------
const MAX_PROMPT_LEN = 800;
const PIPELINE_TIMEOUT_MS = Number(process.env.PIPELINE_TIMEOUT_MS || 120_000);
const LOG_PREVIEW_LEN = 200;
const MAX_SVG_BYTES = Number(process.env.RECRAFT_MAX_SVG_BYTES || 500 * 1024); // 500 KB

// --------------- Helpers ------------------
function newCorrelationId() {
  return crypto.randomBytes(8).toString('hex');
}


function safePreview(s = '', n = LOG_PREVIEW_LEN) {
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function wantDebug(req) {
  const q = String(req.query?.debug || '').toLowerCase();
  const h = String(req.headers?.['x-debug'] || '').toLowerCase();
  const enabled = q === '1' || q === 'true' || h === '1' || h === 'true';
  return enabled && !config.IS_PROD;
}
async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}


// Fallback SVG for critical failures
const FALLBACK_SIMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#f0f0f0"/>
  <circle cx="50" cy="40" r="20" fill="#7c3aed"/>
  <rect x="35" y="60" width="30" height="30" rx="5" fill="#ec4899"/>
  <text x="50" y="95" text-anchor="middle" font-family="Arial" font-size="8" fill="#333">Generated Design</text>
</svg>`;



/**
 * Orchestrator: try each strategy in order and return on first success.
 */
async function generateSvgWithFallbacks(context, timings, cid) {
  const strategies = {
    primary: primaryPipeline,
    gemini_direct: geminiDirectStrategy,
    local_potrace: localPotraceStrategy,
    raster_only: rasterOnlyStrategy,
    emergency_fallback: emergencyFallbackStrategy,
  };

  for (const [name, fn] of Object.entries(strategies)) {
    try {
      console.log(`[${cid}] Attempting ${name} strategy…`);
      const result = await fn(context, timings, cid);
      if (result) {
        result.strategy = name;
        return result;
      }
    } catch (error) {
      console.warn(`[${cid}] ${name} failed:`, error?.message || error);
    }
  }
  
  // If absolutely everything fails, return a minimal response
  return {
    success: false,
    partial: true,
    mode: 'critical_failure',
    svgCode: FALLBACK_SIMPLE_SVG,
    svgUrl: null,
    rasterImageUrl: null,
    enhancedPrompt: '',
    originalPrompt: context.userPrompt,
    message: 'All services are currently unavailable. Please check your configuration and try again.',
    correlationId: cid
  };
}

// --------------- HTTP handler ----------------

async function generateSvg(req, res) {
  const startedNs = nowNs();
  const cid =
    req.headers['x-request-id'] ||
    req.headers['cf-ray'] ||
    req.headers['fly-request-id'] ||
    newCorrelationId();

  // Input validation
  const userPromptRaw = req.body?.userPrompt;
  if (typeof userPromptRaw !== 'string') {
    return res.status(400).json({
      error: 'Please enter a description for the design',
      message: 'User prompt is required',
      correlationId: cid,
    });
  }
  const userPrompt = userPromptRaw.trim();
  if (!userPrompt) {
    return res.status(400).json({
      error: 'Please enter a description for the design',
      message: 'User prompt is required',
      correlationId: cid,
    });
  }
  if (userPrompt.length > MAX_PROMPT_LEN) {
    return res.status(413).json({
      error: 'Prompt too long',
      message: `Please keep your description under ${MAX_PROMPT_LEN} characters.`,
      correlationId: cid,
    });
  }

  const clientMeta = { ip: req.ip, ua: req.headers['user-agent'] || '' };
  console.log(`[START ${cid}] New generation request (${safePreview(userPrompt)}), ip=${clientMeta.ip}`);

  const timings = { enhanceMs: 0, rasterMs: 0, vectorMs: 0, totalMs: 0 };
  const context = { userPrompt, enhancedPrompt: '', raster: null };

  try {
    const pipeline = generateSvgWithFallbacks(context, timings, cid);
    const result = await withTimeout(pipeline, PIPELINE_TIMEOUT_MS, 'generation pipeline');
    timings.totalMs = msSince(startedNs);

    if (wantDebug(req)) result.trace = timings;
    return res.json(result);
  } catch (error) {
    timings.totalMs = msSince(startedNs);
    console.error(`[FATAL ${cid}] All strategies failed: ${error?.message || error}`);
    return res.status(500).json({
      error: 'Failed to create the design',
      message: 'All services failed to generate an SVG.',
      details: config.IS_PROD ? undefined : (error?.message || String(error)),
      correlationId: cid,
      ...(wantDebug(req) ? { trace: timings } : null),
    });
  } finally {
    if (!timings.totalMs) timings.totalMs = msSince(startedNs);
    console.log(
      `[END ${cid}] total=${timings.totalMs}ms, ` +
      `enhance=${timings.enhanceMs}ms, raster=${timings.rasterMs}ms, vector=${timings.vectorMs}ms, ` +
      `ua="${clientMeta.ua}"`
    );
  }
}

module.exports = { generateSvg };