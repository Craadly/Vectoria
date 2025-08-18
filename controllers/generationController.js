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
const path = require('path');
const fs = require('fs').promises;

const config = require('../config/env');
const geminiService = require('../services/geminiService');
const imagenService = require('../services/imagenService');
const { vectorizeImage } = require('../services/recraftService');
const { localVectorize, isLocalVectorizeAvailable } = require('../utils/localVectorize');

// ---------------- Tunables ----------------
const MAX_PROMPT_LEN = 800;
const PIPELINE_TIMEOUT_MS = Number(process.env.PIPELINE_TIMEOUT_MS || 120_000);
const LOG_PREVIEW_LEN = 200;
const MAX_SVG_BYTES = Number(process.env.RECRAFT_MAX_SVG_BYTES || 500 * 1024); // 500 KB

// --------------- Helpers ------------------
function newCorrelationId() {
  return crypto.randomBytes(8).toString('hex');
}
function nowNs() {
  return process.hrtime.bigint();
}
function msSince(startNs) {
  return Number((process.hrtime.bigint() - startNs) / 1_000_000n);
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
async function ensureTempDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
function uniqueSvgName(prefix = 'vector_local') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.svg`;
}
async function saveSvg(svgCode, method = 'unknown', prefix = 'vector_local') {
  await ensureTempDir(config.TEMP_DIR);
  const fileName = uniqueSvgName(prefix);
  const svgPath = path.join(config.TEMP_DIR, fileName);
  await fs.writeFile(svgPath, svgCode, 'utf8');
  return { svgCode, svgUrl: `/temp/${fileName}`, method };
}

// Fallback SVG for critical failures
const FALLBACK_SIMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#f0f0f0"/>
  <circle cx="50" cy="40" r="20" fill="#7c3aed"/>
  <rect x="35" y="60" width="30" height="30" rx="5" fill="#ec4899"/>
  <text x="50" y="95" text-anchor="middle" font-family="Arial" font-size="8" fill="#333">Generated Design</text>
</svg>`;

// Add this function to generate a simple SVG based on prompt keywords
function generateSimpleSVG(prompt) {
  const colors = ['#7c3aed', '#ec4899', '#06b6d4', '#10b981', '#f59e0b'];
  const randomColor = colors[Math.floor(Math.random() * colors.length)];
  
  // Simple keyword-based generation
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`;
  svg += `<rect width="200" height="200" fill="#ffffff"/>`;
  
  if (prompt.toLowerCase().includes('logo')) {
    // Simple logo design
    svg += `<circle cx="100" cy="100" r="60" fill="${randomColor}" opacity="0.9"/>`;
    svg += `<circle cx="100" cy="100" r="40" fill="#ffffff"/>`;
    svg += `<circle cx="100" cy="100" r="20" fill="${randomColor}"/>`;
  } else if (prompt.toLowerCase().includes('character') || prompt.toLowerCase().includes('mascot')) {
    // Simple character
    svg += `<circle cx="100" cy="80" r="30" fill="${randomColor}"/>`;  // Head
    svg += `<ellipse cx="100" cy="130" rx="25" ry="35" fill="${randomColor}"/>`;  // Body
    svg += `<circle cx="88" cy="75" r="5" fill="#ffffff"/>`;  // Left eye
    svg += `<circle cx="112" cy="75" r="5" fill="#ffffff"/>`;  // Right eye
    svg += `<path d="M 90 90 Q 100 95 110 90" stroke="#ffffff" stroke-width="2" fill="none"/>`;  // Smile
  } else if (prompt.toLowerCase().includes('geometric')) {
    // Geometric pattern
    for (let i = 0; i < 5; i++) {
      const x = 40 + (i * 30);
      const y = 40 + (i * 25);
      const size = 30 - (i * 4);
      svg += `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${colors[i % colors.length]}" opacity="0.7" transform="rotate(${i * 15} 100 100)"/>`;
    }
  } else {
    // Default abstract design
    svg += `<polygon points="100,40 140,120 60,120" fill="${randomColor}" opacity="0.8"/>`;
    svg += `<circle cx="100" cy="100" r="40" fill="none" stroke="${randomColor}" stroke-width="3"/>`;
    svg += `<rect x="70" y="70" width="60" height="60" fill="${randomColor}" opacity="0.3" transform="rotate(45 100 100)"/>`;
  }
  
  svg += `</svg>`;
  return svg;
}

// Enhanced fallback strategy with simple SVG generation
async function emergencyFallbackStrategy(context, timings, cid) {
  console.log(`[${cid}] Emergency fallback: generating simple SVG locally...`);
  
  try {
    // Generate a simple SVG based on the prompt
    const simpleSvg = generateSimpleSVG(context.userPrompt);
    
    // Save to temp directory
    const fileName = uniqueSvgName('fallback');
    const filePath = path.join(config.TEMP_DIR, fileName);
    await fs.writeFile(filePath, simpleSvg, 'utf8');
    
    return {
      success: true,
      partial: true,
      mode: 'emergency_fallback',
      svgUrl: `/temp/${fileName}`,
      svgCode: simpleSvg,
      rasterImageUrl: null,
      enhancedPrompt: context.userPrompt + ' (simplified)',
      originalPrompt: context.userPrompt,
      message: 'Generated a simplified design due to service connectivity issues. Please check your API configuration.',
      correlationId: cid
    };
  } catch (error) {
    console.error(`[${cid}] Emergency fallback failed:`, error);
    return null;
  }
}

// --------------- Strategy fns ----------------

/**
 * Primary pipeline:
 *  - Enhance prompt with Gemini
 *  - Generate raster with Imagen
 *  - Vectorize with Recraft (service itself may fall back to local if credits depleted)
 */
async function primaryPipeline(context, timings, cid) {
  const { userPrompt } = context;

  // 1) Enhance
  {
    const t0 = nowNs();
    console.log(`[${cid}] [1/3] Enhancing prompt…`);
    try {
      context.enhancedPrompt = await geminiService.enhancePrompt(userPrompt);
      
      // --- ADD THIS LINE ---
      console.log(`[${cid}] Enhanced Prompt: ${context.enhancedPrompt}`);
      // --- END OF CHANGE ---

    } catch (e) {
      console.warn(`[${cid}] Prompt enhancement failed: ${e?.message || e}`);
      context.enhancedPrompt = userPrompt;
    } finally {
      timings.enhanceMs = msSince(t0);
    }
  }

  // 2) Raster (Imagen)
  {
    const t0 = nowNs();
    console.log(`[${cid}] [2/3] Generating image with Imagen…`);
    try {
      context.raster = await imagenService.generateImage(context.enhancedPrompt);
      // propagate prompt to downstream vectorizer (used only if we ever fall back to direct-gen)
      context.raster.prompt = context.enhancedPrompt;
    } catch (error) {
      console.error(`[${cid}] Raster generation failed: ${error.message}`);
      throw error; // Will be caught by generateSvgWithFallbacks
    }
    timings.rasterMs = msSince(t0);
  }

  // 3) Vectorize (Recraft)
  {
    const t0 = nowNs();
    console.log(`[${cid}] [3/3] Vectorizing image with Recraft…`);
    try {
      const vector = await vectorizeImage(context.raster); // returns { svgCode, svgUrl, method }
      timings.vectorMs = msSince(t0);

      console.log(`[SUCCESS ${cid}] Primary pipeline completed (method=${vector.method || 'unknown'}).`);
      return {
        success: true,
        partial: false,
        mode: vector.method || 'full',
        svgUrl: vector.svgUrl,
        svgCode: vector.svgCode,
        rasterImageUrl: context.raster.imageUrl,
        enhancedPrompt: context.enhancedPrompt,
        originalPrompt: userPrompt,
        message:
          vector.method === 'vector_local'
            ? 'Vectorized locally. Results may differ from cloud vectorization.'
            : 'High-quality SVG design created successfully',
        correlationId: cid,
      };
    } catch (error) {
      console.error(`[${cid}] Vectorization failed: ${error.message}`);
      timings.vectorMs = msSince(t0);
      
      // Immediate fallback to local vectorization
      if (isLocalVectorizeAvailable()) {
        console.warn(`[${cid}] Falling back to local vectorization...`);
        try {
          const localInput = context.raster.imageBuffer ?? context.raster.imagePath;
          const svg = await localVectorize(localInput, {
            resizeMax: 1024,
            threshold: 180,
            turdSize: 50,
            color: '#000000',
            background: '#ffffff',
            svgo: true,
          });
          const saved = await saveSvg(svg, 'vector_local', 'vector_local');
          
          return {
            success: true,
            partial: false,
            mode: 'vector_local',
            svgUrl: saved.svgUrl,
            svgCode: saved.svgCode,
            rasterImageUrl: context.raster.imageUrl,
            enhancedPrompt: context.enhancedPrompt,
            originalPrompt: userPrompt,
            message: 'Vectorized locally. Results may differ from cloud vectorization.',
            correlationId: cid,
          };
        } catch (localError) {
          console.error(`[${cid}] Local vectorization failed: ${localError.message}`);
          throw error; // Will be caught by generateSvgWithFallbacks
        }
      }
      
      throw error; // Will be caught by generateSvgWithFallbacks
    }
  }
}

/**
 * Gemini-direct fallback: ask Gemini to return raw SVG.
 * Can be used even if raster generation failed.
 */
async function geminiDirectStrategy(context, _timings, cid) {
  console.log(`[${cid}] Fallback: generating SVG directly with Gemini…`);
  try {
    const svg = await geminiService.generateFallbackSvg(context.enhancedPrompt || context.userPrompt);
    if (!svg) return null;

    return {
      success: true,
      partial: true,
      mode: 'fallback_svg',
      svgUrl: svg.svgUrl,
      svgCode: svg.svgCode,
      rasterImageUrl: context.raster?.imageUrl || null,
      enhancedPrompt: context.enhancedPrompt,
      originalPrompt: context.userPrompt,
      message: 'SVG design created using fallback mode',
      correlationId: cid,
    };
  } catch (error) {
    console.error(`[${cid}] Gemini direct SVG failed: ${error.message}`);
    return null;
  }
}

/**
 * Local potrace fallback: requires a raster result.
 * Only run if we already have raster bytes/path in context.
 */
async function localPotraceStrategy(context, _timings, cid) {
  if (!context.raster) return null;
  if (!isLocalVectorizeAvailable()) return null;

  console.log(`[${cid}] Fallback: vectorizing locally via potrace…`);
  try {
    const localInput = context.raster.imageBuffer ?? context.raster.imagePath;
    const svg = await localVectorize(localInput, {
      resizeMax: 1024,
      threshold: 180,
      turdSize: 50,
      color: '#000000',
      background: '#ffffff',
      svgo: true,
    });

    const saved = await saveSvg(svg, 'vector_local', 'vector_local');
    return {
      success: true,
      partial: false,
      mode: 'vector_local',
      svgUrl: saved.svgUrl,
      svgCode: saved.svgCode,
      rasterImageUrl: context.raster.imageUrl,
      enhancedPrompt: context.enhancedPrompt,
      originalPrompt: context.userPrompt,
      message: 'Vectorized locally. Results may differ from cloud vectorization.',
      correlationId: cid,
    };
  } catch (error) {
    console.error(`[${cid}] Local vectorization failed: ${error.message}`);
    return null;
  }
}

/**
 * Raster-only fallback: show PNG if we have it, with an explanatory message.
 */
async function rasterOnlyStrategy(context, _timings, cid) {
  if (!context.raster?.imageUrl) return null;
  
  return {
    success: true,
    partial: true,
    mode: 'raster_only',
    svgUrl: null,
    svgCode: null,
    rasterImageUrl: context.raster.imageUrl,
    enhancedPrompt: context.enhancedPrompt,
    originalPrompt: context.userPrompt,
    message: 'Vectorization temporarily unavailable. Showing raster only.',
    correlationId: cid,
  };
}

/**
 * Orchestrator: try each strategy in order and return on first success.
 */
async function generateSvgWithFallbacks(context, timings, cid) {
  const strategies = [
    { name: 'primary',       fn: () => primaryPipeline(context, timings, cid) },
    { name: 'gemini_direct', fn: () => geminiDirectStrategy(context, timings, cid) },
    { name: 'local_potrace', fn: () => localPotraceStrategy(context, timings, cid) },
    { name: 'raster_only',   fn: () => rasterOnlyStrategy(context, timings, cid) },
    { name: 'emergency_fallback', fn: () => emergencyFallbackStrategy(context, timings, cid) }
  ];

  for (const strategy of strategies) {
    try {
      console.log(`[${cid}] Attempting ${strategy.name} strategy…`);
      const result = await strategy.fn();
      if (result) {
        result.strategy = strategy.name;
        return result;
      }
    } catch (error) {
      console.warn(`[${cid}] ${strategy.name} failed:`, error?.message || error);
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