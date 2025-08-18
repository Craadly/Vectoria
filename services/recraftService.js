// services/recraftService.js
'use strict';

/**
 * Enhanced Recraft service with super intelligence for SVG conversion.
 * Optimized for working with enhanced Gemini prompts and Imagen outputs.
 */

const http = require('http');
const https = require('https');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const config = require('../config/env');
const { localVectorize, isLocalVectorizeAvailable } = require('../utils/localVectorize');

// Optional dependencies
let svgoOptimize = null;
try { svgoOptimize = require('svgo').optimize; } catch {}
let sharp = null;
try { sharp = require('sharp'); } catch {}

// Enhanced Configuration
const DEFAULT_TIMEOUT_MS = Number(process.env.RECRAFT_HTTP_TIMEOUT_MS || 45_000);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 600;
const MAX_SVG_BYTES = Number(process.env.RECRAFT_MAX_SVG_BYTES || 500 * 1024);
const USER_AGENT = process.env.RECRAFT_USER_AGENT || 'Craadly-Vectoria/2.0-Enhanced';
const COOLDOWN_MINUTES = Number(process.env.RECRAFT_COOLDOWN_MINUTES || 20);
const RECRAFT_ALLOW_DIRECT_GEN = process.env.RECRAFT_ALLOW_DIRECT_GEN !== 'false';

// API endpoints
const RECRAFT_VECTORIZE_ENDPOINT = 'https://external.api.recraft.ai/v1/images/vectorize';
const RECRAFT_GENERATE_ENDPOINT = 'https://external.api.recraft.ai/v1/images/generations';
// ✅ NEW: remove background endpoint
const RECRAFT_REMOVE_BG_ENDPOINT = 'https://external.api.recraft.ai/v1/images/removeBackground';

// Validate configuration
if (!config?.TEMP_DIR) throw new Error('TEMP_DIR is missing in config.');
if (!config?.RECRAFT_API_KEY) {
  console.warn('⚠️ RECRAFT_API_KEY is missing — will use intelligent local fallback.');
}

// =============== INTELLIGENCE SYSTEM ===============

/**
 * Style-specific vectorization profiles for optimal results
 */
const VECTORIZATION_PROFILES = {
  logo: {
    recraftStyle: 'vector_illustration',
    outputFormat: 'svg',
    complexity: 'simple',
    localOptions: {
      resizeMax: 1024,
      threshold: 160,
      turdSize: 30,
      turnPolicy: 'black',
      alphaMax: 1.0,
      opticurve: true,
      optTolerance: 0.2
    },
    svgoConfig: {
      plugins: [
        'preset-default',
        { name: 'convertColors', params: { currentColor: false } },
        { name: 'removeUselessStrokeAndFill', active: false },
        { name: 'cleanupIds', active: true }
      ]
    },
    validation: {
      maxColors: 5,
      preferShapes: ['rect', 'circle', 'polygon'],
      minPathComplexity: 'low'
    }
  },
  minimal: {
    recraftStyle: 'vector_illustration',
    outputFormat: 'svg',
    complexity: 'minimal',
    localOptions: {
      resizeMax: 800,
      threshold: 180,
      turdSize: 50,
      turnPolicy: 'minority',
      alphaMax: 1.0,
      opticurve: true
    },
    svgoConfig: {
      plugins: [
        'preset-default',
        { name: 'mergePaths', active: true },
        { name: 'removeUselessStrokeAndFill', active: true }
      ]
    },
    validation: {
      maxColors: 3,
      preferShapes: ['path', 'rect'],
      minPathComplexity: 'very-low'
    }
  },
  geometric: {
    recraftStyle: 'vector_illustration',
    outputFormat: 'svg',
    complexity: 'moderate',
    localOptions: {
      resizeMax: 1200,
      threshold: 150,
      turdSize: 20,
      turnPolicy: 'white',
      alphaMax: 1.3,
      opticurve: false // Keep sharp edges
    },
    svgoConfig: {
      plugins: [
        'preset-default',
        { name: 'convertShapeToPath', active: false }, // Keep geometric shapes
        { name: 'convertPathData', params: { floatPrecision: 3 } }
      ]
    },
    validation: {
      maxColors: 8,
      preferShapes: ['polygon', 'rect', 'line'],
      minPathComplexity: 'moderate'
    }
  },
  character: {
    recraftStyle: 'digital_illustration',
    outputFormat: 'svg',
    complexity: 'complex',
    localOptions: {
      resizeMax: 1024,
      threshold: 140,
      turdSize: 15,
      turnPolicy: 'black',
      alphaMax: 1.5,
      opticurve: true,
      optTolerance: 0.5
    },
    svgoConfig: {
      plugins: [
        'preset-default',
        { name: 'removeViewBox', active: false },
        { name: 'removeDimensions', active: true }
      ]
    },
    validation: {
      maxColors: 12,
      preferShapes: ['path', 'ellipse', 'circle'],
      minPathComplexity: 'high'
    }
  },
  technical: {
    recraftStyle: 'line_art',
    outputFormat: 'svg',
    complexity: 'precise',
    localOptions: {
      resizeMax: 2048,
      threshold: 200,
      turdSize: 10,
      turnPolicy: 'right',
      alphaMax: 0.5,
      opticurve: false // Maximum precision
    },
    svgoConfig: {
      plugins: [
        'preset-default',
        { name: 'cleanupNumericValues', params: { floatPrecision: 4 } },
        { name: 'convertPathData', params: { floatPrecision: 4 } }
      ]
    },
    validation: {
      maxColors: 2,
      preferShapes: ['line', 'polyline', 'path'],
      minPathComplexity: 'precise'
    }
  },
  organic: {
    recraftStyle: 'vector_illustration',
    outputFormat: 'svg',
    complexity: 'flowing',
    localOptions: {
      resizeMax: 1024,
      threshold: 130,
      turdSize: 25,
      turnPolicy: 'minority',
      alphaMax: 2.0,
      opticurve: true,
      optTolerance: 1.0
    },
    svgoConfig: {
      plugins: [
        'preset-default',
        { name: 'convertShapeToPath', active: true },
        { name: 'smoothPaths', active: true }
      ]
    },
    validation: {
      maxColors: 10,
      preferShapes: ['path', 'curve'],
      minPathComplexity: 'smooth'
    }
  },
  default: {
    recraftStyle: 'vector_illustration',
    outputFormat: 'svg',
    complexity: 'balanced',
    localOptions: {
      resizeMax: 1024,
      threshold: 160,
      turdSize: 30,
      turnPolicy: 'minority',
      alphaMax: 1.0,
      opticurve: true
    },
    svgoConfig: {
      plugins: ['preset-default']
    },
    validation: {
      maxColors: 8,
      preferShapes: ['path', 'rect', 'circle'],
      minPathComplexity: 'moderate'
    }
  }
};

/**
 * Quality assessment metrics for SVG output
 */
class SVGQualityAnalyzer {
  static async analyze(svgCode) {
    const metrics = {
      score: 1.0,
      fileSize: Buffer.byteLength(svgCode, 'utf8'),
      pathCount: 0,
      shapeCount: 0,
      colorCount: 0,
      complexity: 'unknown',
      issues: [],
      suggestions: []
    };

    try {
      // Count paths and shapes
      metrics.pathCount = (svgCode.match(/<path/gi) || []).length;
      metrics.shapeCount = (svgCode.match(/<(rect|circle|ellipse|polygon|line|polyline)/gi) || []).length;
      
      // Count unique colors
      const colors = new Set();
      const colorMatches = svgCode.matchAll(/(?:fill|stroke)="([^"]+)"/gi);
      for (const match of colorMatches) {
        if (match[1] && match[1] !== 'none' && match[1] !== 'transparent') {
          colors.add(match[1].toLowerCase());
        }
      }
      metrics.colorCount = colors.size;

      // Assess complexity
      const totalElements = metrics.pathCount + metrics.shapeCount;
      if (totalElements < 10) metrics.complexity = 'simple';
      else if (totalElements < 50) metrics.complexity = 'moderate';
      else if (totalElements < 100) metrics.complexity = 'complex';
      else metrics.complexity = 'very-complex';

      // Quality scoring
      if (metrics.fileSize > 200_000) {
        metrics.score -= 0.2;
        metrics.issues.push('File size too large');
        metrics.suggestions.push('Consider simplifying paths');
      }

      if (metrics.pathCount > 150) {
        metrics.score -= 0.15;
        metrics.issues.push('Too many paths');
        metrics.suggestions.push('Merge similar paths');
      }

      if (metrics.colorCount > 20) {
        metrics.score -= 0.1;
        metrics.issues.push('Too many colors');
        metrics.suggestions.push('Reduce color palette');
      }

      // Check for common issues
      if (svgCode.includes('base64')) {
        metrics.score -= 0.3;
        metrics.issues.push('Contains embedded raster images');
      }

      if (svgCode.includes('gradient')) {
        metrics.score -= 0.1;
        metrics.issues.push('Contains gradients');
      }

      if (!svgCode.includes('viewBox')) {
        metrics.score -= 0.1;
        metrics.issues.push('Missing viewBox attribute');
      }

      metrics.score = Math.max(0, metrics.score);

    } catch (error) {
      console.warn('SVG analysis error:', error.message);
    }

    return metrics;
  }
}

// =============== CONNECTION MANAGEMENT ===============

class EnhancedConnectionManager {
  constructor({ maxConnections = 12, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    this.pool = new Map();
    this.maxConnections = maxConnections;
    this.timeout = timeout;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  _keyFromUrl(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      return 'default';
    }
  }

  _createEntry(key) {
    const httpAgent = new http.Agent({ 
      keepAlive: true, 
      maxSockets: this.maxConnections,
      keepAliveMsecs: 3000 
    });
    
    const httpsAgent = new https.Agent({ 
      keepAlive: true, 
      maxSockets: this.maxConnections,
      keepAliveMsecs: 3000,
      rejectUnauthorized: true
    });

    const instance = axios.create({
      timeout: this.timeout,
      httpAgent,
      httpsAgent,
      maxRedirects: 5,
      headers: { 'User-Agent': USER_AGENT },
      transformResponse: [(d) => d],
      validateStatus: (s) => s >= 200 && s < 300,
    });

    // Add request/response interceptors for monitoring
    instance.interceptors.request.use(
      (config) => {
        this.requestCount++;
        console.log(`📡 [Request #${this.requestCount}] ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.errorCount++;
        return Promise.reject(error);
      }
    );

    this.pool.set(key, { axios: instance, httpAgent, httpsAgent });
    return this.pool.get(key);
  }

  getAxios(url) {
    const key = this._keyFromUrl(url);
    if (!this.pool.has(key)) return this._createEntry(key).axios;
    return this.pool.get(key).axios;
  }

  getStats() {
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      errorRate: this.requestCount > 0 ? (this.errorCount / this.requestCount) : 0,
      connections: this.pool.size
    };
  }

  cleanup() {
    for (const [, entry] of this.pool) {
      try { entry.httpAgent?.destroy?.(); } catch {}
      try { entry.httpsAgent?.destroy?.(); } catch {}
    }
    this.pool.clear();
    console.log(`🧹 Connection pool cleaned. Stats:`, this.getStats());
  }
}

const connMgr = new EnhancedConnectionManager({
  maxConnections: Number(process.env.RECRAFT_MAX_CONNECTIONS || 12),
  timeout: DEFAULT_TIMEOUT_MS,
});

// =============== HELPER FUNCTIONS ===============

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base * (0.8 + Math.random() * 0.4);

/**
 * Detect style from image metadata or prompt
 */
function detectStyleFromImage(imageData) {
  // Check metadata from enhanced Imagen service
  if (imageData?.metadata?.profile) {
    return imageData.metadata.profile;
  }
  if (imageData?.style) {
    return imageData.style;
  }
  
  // Fallback to prompt analysis
  const prompt = imageData?.prompt || '';
  const lower = prompt.toLowerCase();
  
  if (lower.includes('logo') || lower.includes('brand')) return 'logo';
  if (lower.includes('minimal') || lower.includes('simple')) return 'minimal';
  if (lower.includes('geometric') || lower.includes('angular')) return 'geometric';
  if (lower.includes('character') || lower.includes('mascot')) return 'character';
  if (lower.includes('technical') || lower.includes('blueprint')) return 'technical';
  if (lower.includes('organic') || lower.includes('flowing')) return 'organic';
  
  return 'default';
}

/**
 * Enhanced retry logic with exponential backoff
 */
async function getWithRetry(url, cfg = {}) {
  const httpc = connMgr.getAxios(url);
  let lastErr;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await httpc.get(url, cfg);
    } catch (err) {
      lastErr = err;
      const code = err?.response?.status || err?.code;
      const retryable =
        [429, 500, 502, 503, 504].includes(Number(code)) ||
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT' ||
        /socket hang up/i.test(String(err?.message || ''));
      
      if (!retryable || attempt === MAX_RETRIES) break;
      
      const delay = Math.min(10000, jitter(RETRY_BASE_MS) * Math.pow(2, attempt));
      console.log(`⏳ Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Robust POST with connection recovery
 */
async function postRobust(url, body, headers, timeout = DEFAULT_TIMEOUT_MS) {
  const httpc = connMgr.getAxios(url);
  
  try {
    return await httpc.post(url, body, { headers, timeout });
  } catch (e) {
    // Handle connection resets by creating new connection
    if (
      ['ECONNRESET', 'EPIPE'].includes(e.code) ||
      /socket hang up/i.test(String(e.message || ''))
    ) {
      console.warn('⚠️ Connection reset, creating new connection...');
      const noKA = axios.create({
        timeout,
        httpsAgent: new https.Agent({ keepAlive: false }),
        httpAgent: new http.Agent({ keepAlive: false }),
        transformResponse: [(d) => d],
        validateStatus: (s) => s >= 200 && s < 300,
        headers: { 'User-Agent': USER_AGENT },
      });
      return await noKA.post(url, body, { headers });
    }
    throw e;
  }
}

function summarizeAxiosError(err) {
  const status = err?.response?.status;
  const headers = err?.response?.headers || {};
  let body = err?.response?.data;
  
  try {
    if (typeof body === 'string' && body.length < 2000 && /^[\[{"]/.test(body)) {
      body = JSON.parse(body);
    }
  } catch {}
  
  const hint = typeof body === 'object'
    ? (body.error?.message || body.message || body.detail || body.code || JSON.stringify(body).slice(0, 500))
    : typeof body === 'string'
      ? body.slice(0, 500)
      : '';
  
  return {
    status,
    hint,
    json: typeof body === 'object' ? body : null,
    rate: {
      remaining: headers['x-ratelimit-remaining'],
      limit: headers['x-ratelimit-limit'],
      reset: headers['x-ratelimit-reset'],
    },
  };
}

// =============== SVG PROCESSING ===============

/**
 * Enhanced SVG sanitization with style preservation
 */
function sanitizeSvg(svg, profile = null) {
  let s = String(svg || '');

  // Remove dangerous elements
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  s = s.replace(/(?:xlink:)?href\s*=\s*(['"])javascript:[\s\S]*?\1/gi, '');
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  
  // Conditional gradient removal based on profile
  if (!profile || profile.validation.maxColors < 10) {
    s = s.replace(/<linearGradient[\s\S]*?<\/linearGradient>/gi, '');
    s = s.replace(/<radialGradient[\s\S]*?<\/radialGradient>/gi, '');
  }

  // Remove embedded images
  s = s.replace(/<image[\s\S]*?>/gi, '');
  
  // Clean up filters (except for technical style)
  if (profile?.recraftStyle !== 'line_art') {
    s = s.replace(/filter\s*=\s*(['"]).*?\1/gi, '');
    s = s.replace(/<filter[\s\S]*?<\/filter>/gi, '');
  }

  // Normalize SVG root
  s = s.replace(/\s(width|height)\s*=\s*(['"]).*?\2/gi, '');
  if (!/viewBox\s*=/.test(s)) {
    s = s.replace(/<svg/i, '<svg viewBox="0 0 100 100"');
  }
  if (!/xmlns\s*=/.test(s)) {
    s = s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  // Add title for accessibility
  if (!/\<title\>/i.test(s) && profile) {
    const title = `<title>${profile.recraftStyle} vector illustration</title>`;
    s = s.replace(/(<svg[^>]*>)/i, `$1\n  ${title}\n`);
  }

  return s.trim();
}

/**
 * Intelligent SVG optimization based on style
 */
async function optimizeSvg(svg, style = 'default') {
  if (!svgoOptimize) return svg;
  
  const profile = VECTORIZATION_PROFILES[style] || VECTORIZATION_PROFILES.default;
  
  try {
    const { data } = svgoOptimize(svg, {
      multipass: true,
      plugins: profile.svgoConfig.plugins || ['preset-default']
    });
    
    console.log(`✨ SVG optimized for ${style} style`);
    return data || svg;
  } catch (error) {
    console.warn('⚠️ SVGO optimization failed:', error.message);
    return svg;
  }
}

/**
 * Prepare image for optimal vectorization
 */
async function prepareImageForVectorization(imageData, style) {
  const profile = VECTORIZATION_PROFILES[style] || VECTORIZATION_PROFILES.default;
  
  if (sharp) {
    let sharpInstance;
    
    if (imageData?.imageBuffer) {
      sharpInstance = sharp(imageData.imageBuffer);
    } else if (imageData?.imagePath) {
      sharpInstance = sharp(imageData.imagePath);
    } else {
      throw new Error('No image data provided');
    }
    
    // Get metadata
    const metadata = await sharpInstance.metadata();
    console.log(`📐 Preparing ${metadata.width}x${metadata.height} image for ${style} vectorization`);
    
    // Apply style-specific preprocessing
    let processed = sharpInstance
      .resize({
        width: profile.localOptions.resizeMax,
        height: profile.localOptions.resizeMax,
        fit: 'inside',
        withoutEnlargement: true
      });
    
    // Apply style-specific filters
    if (style === 'technical') {
      // Convert to high-contrast B&W for technical drawings
      processed = processed
        .greyscale()
        .threshold(profile.localOptions.threshold);
    } else if (style === 'minimal') {
      // Reduce colors for minimal style
      processed = processed
        .png({ colors: 8, dither: 0.0 });
    } else if (style === 'logo') {
      // High contrast for logos
      processed = processed
        .modulate({ brightness: 1.1, saturation: 1.2 })
        .sharpen();
    }
    
    const buffer = await processed
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    
    return {
      buffer,
      filename: `prepared_${style}_${Date.now()}.png`,
      mime: 'image/png',
      metadata: { style, originalSize: metadata.width }
    };
  }
  
  // Fallback without sharp
  if (imageData?.imageBuffer) {
    return {
      buffer: imageData.imageBuffer,
      filename: imageData.filename || `src_${Date.now()}.bin`,
      mime: imageData.mimeType || 'application/octet-stream',
      metadata: { style }
    };
  }
  
  if (imageData?.imagePath) {
    const buf = await fsp.readFile(imageData.imagePath);
    return {
      buffer: buf,
      filename: path.basename(imageData.imagePath),
      mime: 'application/octet-stream',
      metadata: { style }
    };
  }
  
  throw new Error('imageData must include imagePath or imageBuffer.');
}

// =============== CREDIT MANAGEMENT ===============

let recraftCooldownUntil = 0;
let creditWarningCount = 0;

function isRecraftInCooldown() {
  return Date.now() < recraftCooldownUntil;
}

function startCooldown(minutes = COOLDOWN_MINUTES) {
  recraftCooldownUntil = Date.now() + minutes * 60_000;
  creditWarningCount++;
  
  const mins = Math.max(1, Math.round((recraftCooldownUntil - Date.now()) / 60000));
  console.warn(`💸 Recraft cooldown #${creditWarningCount} enabled for ~${mins} minute(s).`);
  
  // Progressive cooldown increases
  if (creditWarningCount > 3) {
    recraftCooldownUntil += 10 * 60_000; // Add 10 more minutes
    console.warn(`⚠️ Multiple credit depletions detected. Extended cooldown.`);
  }
}

// =============== NEW: Remove Background via Recraft ===============

/**
 * Calls Recraft removeBackground and returns { buffer, filename, mime }.
 * Supports both image.url and b64_json response formats.
 */
async function recraftRemoveBackground(imagePathOrBuffer) {
  console.log('🧹 Removing background via Recraft...');
  const form = new FormData();

  // Per Recraft docs, upload under "file"
  if (Buffer.isBuffer(imagePathOrBuffer)) {
    form.append('file', imagePathOrBuffer, {
      filename: `input_${Date.now()}.png`,
      contentType: 'image/png',
    });
  } else if (typeof imagePathOrBuffer === 'string' && fs.existsSync(imagePathOrBuffer)) {
    form.append('file', fs.createReadStream(imagePathOrBuffer));
  } else {
    throw new Error('recraftRemoveBackground: invalid input (expected Buffer or readable file path)');
  }

  // Prefer URL to reduce payload size; can be overridden by env
  form.append('response_format', process.env.RECRAFT_BG_RESPONSE || 'url');

  const res = await postRobust(
    RECRAFT_REMOVE_BG_ENDPOINT,
    form,
    {
      ...form.getHeaders(),
      Authorization: `Bearer ${config.RECRAFT_API_KEY}`,
      Accept: 'application/json',
    },
    DEFAULT_TIMEOUT_MS
  );

  let payload = res?.data;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch {}
  }

  // Try b64_json first
  const b64 = payload?.data?.[0]?.b64_json || payload?.b64_json;
  if (b64) {
    return {
      buffer: Buffer.from(b64, 'base64'),
      filename: `nobg_${Date.now()}.png`,
      mime: 'image/png',
    };
  }

  // Fallback to image URL forms
  const url = payload?.image?.url || payload?.data?.[0]?.url || payload?.url;
  if (url) {
    const dl = await getWithRetry(url, { responseType: 'arraybuffer' });
    return {
      buffer: Buffer.from(dl.data),
      filename: `nobg_${Date.now()}.png`,
      mime: 'image/png',
    };
  }

  throw new Error('Recraft removeBackground: missing image.url or b64_json');
}

// =============== MAIN VECTORIZATION ===============

/**
 * Enhanced vectorization with super intelligence
 * ✅ Now includes background removal before vectorization
 */
async function vectorizeImage(imageData) {
  const startTime = Date.now();
  const vectorizationId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n🎨 [Vectorization ${vectorizationId}] Starting intelligent SVG conversion...`);
  
  // Detect style from image metadata
  const detectedStyle = detectStyleFromImage(imageData);
  const profile = VECTORIZATION_PROFILES[detectedStyle];
  
  console.log(`📊 Detected style: ${detectedStyle}`);
  console.log(`🎯 Using profile: ${profile.recraftStyle}, complexity: ${profile.complexity}`);
  
  const hasRaster = !!(imageData?.imageBuffer || imageData?.imagePath);

  // Check cooldown status
  if (isRecraftInCooldown()) {
    const remainingMins = Math.ceil((recraftCooldownUntil - Date.now()) / 60000);
    console.warn(`⏭️ Recraft in cooldown (${remainingMins}m remaining). Using intelligent local fallback.`);
    
    if (isLocalVectorizeAvailable()) {
      return await intelligentLocalVectorization(imageData, detectedStyle, vectorizationId);
    }
  }

  // Check API key availability
  if (!config?.RECRAFT_API_KEY) {
    console.warn('⏭️ No Recraft API key. Using intelligent local vectorization.');
    
    if (isLocalVectorizeAvailable()) {
      return await intelligentLocalVectorization(imageData, detectedStyle, vectorizationId);
    }
    
    throw new Error('RECRAFT_API_KEY missing and local vectorization unavailable.');
  }

  // Prepare image with style-specific optimizations
  let preparedImage = null;
  if (hasRaster) {
    try {
      console.log(`🔧 Preparing image for ${detectedStyle} vectorization...`);
      preparedImage = await prepareImageForVectorization(imageData, detectedStyle);
    } catch (error) {
      console.warn('⚠️ Image preparation failed:', error.message);
      preparedImage = await prepareUploadBasic(imageData);
    }
  }

  // ✅ NEW: remove background first (Recraft)
  let bgRemoved = preparedImage;
  if (preparedImage) {
    try {
      const rb = await recraftRemoveBackground(preparedImage.buffer || preparedImage.filename);
      bgRemoved = rb || preparedImage;
    } catch (err) {
      console.warn(`⚠️ Background removal failed, proceeding with prepared image: ${err.message}`);
      bgRemoved = preparedImage;
    }
  }

  // Try Recraft API vectorization
  if (bgRemoved) {
    try {
      console.log(`📡 [Recraft API] Attempting cloud vectorization...`);
      
      const form = new FormData();
      // Preserve your original field name ('image') for vectorize
      form.append('image', bgRemoved.buffer || preparedImage.buffer, {
        filename: (bgRemoved && bgRemoved.filename) || preparedImage.filename,
        contentType: (bgRemoved && bgRemoved.mime) || preparedImage.mime
      });
      form.append('output_format', profile.outputFormat);
      form.append('style', profile.recraftStyle);
      
      // Add style-specific parameters
      if (profile.complexity === 'simple' || profile.complexity === 'minimal') {
        form.append('simplify', 'true');
      }
      if (detectedStyle === 'technical') {
        form.append('preserve_details', 'true');
      }

      const res = await postRobust(
        RECRAFT_VECTORIZE_ENDPOINT,
        form,
        {
          ...form.getHeaders(),
          Authorization: `Bearer ${config.RECRAFT_API_KEY}`,
          Accept: 'application/json, text/plain, image/svg+xml, */*',
        },
        60_000
      );

      // Process response
      const svg = await processRecraftResponse(res, detectedStyle);
      
      if (svg) {
        console.log(`✅ [Recraft API] Successfully vectorized in ${Date.now() - startTime}ms`);
        
        // Analyze quality
        const quality = await SVGQualityAnalyzer.analyze(svg);
        console.log(`📊 Quality score: ${(quality.score * 100).toFixed(0)}%`);
        
        if (quality.issues.length > 0) {
          console.log(`⚠️ Issues: ${quality.issues.join(', ')}`);
        }
        
        return {
          svgCode: svg,
          svgUrl: await saveOptimizedSvg(svg, 'recraft_api_bg_removed', detectedStyle),
          method: 'recraft_api_bg_removed',
          style: detectedStyle,
          quality,
          duration: Date.now() - startTime
        };
      }
    } catch (error) {
      handleRecraftError(error);
    }
  }

  // Fallback to intelligent local vectorization
  console.warn('⚠️ Recraft API failed. Using intelligent local vectorization...');
  return await intelligentLocalVectorization(imageData, detectedStyle, vectorizationId);
}

/**
 * Process Recraft API response intelligently
 */
async function processRecraftResponse(res, style) {
  const raw = res?.data;
  
  if (!raw || (typeof raw === 'string' && raw.trim() === '')) {
    throw new Error('Empty response from Recraft API');
  }

  // Try to parse JSON response
  let data = raw;
  if (typeof raw === 'string' && /^[\[{]/.test(raw.trim())) {
    try {
      data = JSON.parse(raw);
    } catch {
      // Maybe it's direct SVG
      if (isLikelySvg(raw)) {
        data = { svg: raw };
      }
    }
  }

  // Handle various response formats
  let svg = null;
  
  // Direct SVG in response
  if (data?.svg) {
    svg = data.svg;
  } else if (Array.isArray(data?.data) && data.data[0]?.svg) {
    svg = data.data[0].svg;
  } else if (data?.content && isLikelySvg(data.content)) {
    svg = extractSvg(data.content);
  }
  
  // Handle URL responses
  if (!svg) {
    let svgUrl = data?.url || data?.data?.[0]?.url || data?.image?.url;
    
    if (svgUrl) {
      console.log(`📥 Fetching SVG from URL: ${svgUrl}`);
      const dl = await getWithRetry(svgUrl, {
        responseType: 'text',
        headers: { Accept: 'image/svg+xml,text/xml;q=0.9,*/*;q=0.8' },
      });
      
      let fetched = String(dl?.data || '');
      
      // Check if we got PNG instead of SVG
      if (fetched.startsWith('�PNG') || fetched.includes('<title>PNG image</title>')) {
        throw new Error('Recraft returned PNG instead of SVG');
      }
      
      svg = extractSvg(fetched) || fetched;
      
      if (!isLikelySvg(svg)) {
        throw new Error('Response does not contain valid SVG');
      }
    }
  }
  
  if (!svg) {
    throw new Error('No SVG found in Recraft response');
  }
  
  // Sanitize and optimize
  const profile = VECTORIZATION_PROFILES[style] || VECTORIZATION_PROFILES.default;
  svg = sanitizeSvg(svg, profile);
  
  // Check size constraints
  const size = Buffer.byteLength(svg, 'utf8');
  if (size > MAX_SVG_BYTES) {
    console.warn(`⚠️ SVG too large (${size} bytes), optimizing...`);
    svg = await optimizeSvg(svg, style);
    
    // If still too large, apply aggressive optimization
    if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
      svg = svg.replace(/\s+/g, ' ');
      svg = svg.replace(/(\d+\.\d{2})\d+/g, '$1');
    }
  }
  
  // Final optimization pass
  svg = await optimizeSvg(svg, style);
  
  return svg;
}

/**
 * Intelligent local vectorization with style-specific parameters
 */
async function intelligentLocalVectorization(imageData, style, vectorizationId) {
  if (!isLocalVectorizeAvailable()) {
    throw new Error('Local vectorization not available. Install potrace.');
  }
  
  const profile = VECTORIZATION_PROFILES[style] || VECTORIZATION_PROFILES.default;
  const startTime = Date.now();
  
  console.log(`🔮 [Local ${vectorizationId}] Starting intelligent local vectorization...`);
  console.log(`🎨 Style: ${style}, Complexity: ${profile.complexity}`);
  
  try {
    const localInput = imageData?.imageBuffer ?? imageData?.imagePath;
    
    // Apply style-specific local vectorization options
    const options = {
      ...profile.localOptions,
      ...(imageData?.localOptions || {})
    };
    
    console.log(`⚙️ Potrace options:`, options);
    
    const svg = await localVectorize(localInput, options);
    
    // Post-process with style-specific optimizations
    let optimized = sanitizeSvg(svg, profile);
    optimized = await optimizeSvg(optimized, style);
    
    // Quality assessment
    const quality = await SVGQualityAnalyzer.analyze(optimized);
    console.log(`📊 Local vectorization quality: ${(quality.score * 100).toFixed(0)}%`);
    
    if (quality.suggestions.length > 0) {
      console.log(`💡 Suggestions: ${quality.suggestions.join(', ')}`);
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ [Local ${vectorizationId}] Completed in ${duration}ms`);
    
    return {
      svgCode: optimized,
      svgUrl: await saveOptimizedSvg(optimized, 'local_intelligent', style),
      method: 'local_intelligent',
      style,
      quality,
      duration
    };
    
  } catch (error) {
    console.error(`❌ [Local ${vectorizationId}] Failed:`, error.message);
    throw error;
  }
}

/**
 * Save optimized SVG with proper naming
 */
async function saveOptimizedSvg(svgCode, method, style) {
  await ensureTempDir(config.TEMP_DIR);
  const fileName = `vector_${style}_${method}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.svg`;
  const svgPath = path.join(config.TEMP_DIR, fileName);
  await fsp.writeFile(svgPath, svgCode, 'utf8');
  
  const size = Buffer.byteLength(svgCode, 'utf8');
  console.log(`💾 Saved: ${fileName} (${(size / 1024).toFixed(1)}KB)`);
  
  return `/temp/${fileName}`;
}

/**
 * Handle Recraft API errors intelligently
 */
function handleRecraftError(error) {
  const info = summarizeAxiosError(error);
  
  console.error(
    `❌ [Recraft API] Error:`,
    `Status: ${info.status || 'N/A'}`,
    `Message: ${error.message}`,
    info.json ? `Details: ${JSON.stringify(info.json).slice(0, 300)}` : ''
  );
  
  // Handle credit depletion
  if (
    info.status === 402 ||
    info.status === 429 ||
    /not_enough_credits/i.test(info.hint || '') ||
    /rate_limit_exceeded/i.test(info.hint || '')
  ) {
    startCooldown();
  }
  
  // Log rate limit info
  if (info.rate.remaining !== undefined) {
    console.warn(`📊 Rate limit: ${info.rate.remaining}/${info.rate.limit}, reset: ${info.rate.reset}`);
  }
}

// =============== UTILITY FUNCTIONS ===============

function isLikelySvg(text) {
  return /<svg[\s\S]*<\/svg>/i.test(text || '');
}

function extractSvg(text) {
  const m = String(text || '').match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0] : null;
}

async function ensureTempDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function prepareUploadBasic(imageData) {
  if (imageData?.imageBuffer) {
    return {
      buffer: imageData.imageBuffer,
      filename: imageData.filename || `src_${Date.now()}.bin`,
      mime: imageData.mimeType || 'application/octet-stream'
    };
  }
  
  if (imageData?.imagePath) {
    const buf = await fsp.readFile(imageData.imagePath);
    return {
      buffer: buf,
      filename: path.basename(imageData.imagePath),
      mime: 'application/octet-stream'
    };
  }
  
  throw new Error('imageData must include imagePath or imageBuffer.');
}

// =============== ADVANCED FEATURES ===============

/**
 * Generate multiple vectorization attempts with different settings
 */
async function vectorizeWithVariations(imageData, count = 3) {
  console.log(`🎭 Generating ${count} vectorization variations...`);
  
  const variations = [];
  const styles = ['minimal', 'geometric', 'default'];
  
  for (let i = 0; i < Math.min(count, styles.length); i++) {
    try {
      // Override detected style with variation
      const variedData = {
        ...imageData,
        style: styles[i],
        metadata: { ...imageData.metadata, profile: styles[i] }
      };
      
      const result = await vectorizeImage(variedData);
      variations.push(result);
      
      console.log(`✅ Variation ${i + 1}/${count} completed (${styles[i]} style, score: ${(result.quality?.score * 100 || 0).toFixed(0)}%)`);
    } catch (error) {
      console.warn(`⚠️ Variation ${i + 1} failed:`, error.message);
    }
  }
  
  if (variations.length === 0) {
    throw new Error('Failed to generate any variations');
  }
  
  // Sort by quality score and return best
  variations.sort((a, b) => (b.quality?.score || 0) - (a.quality?.score || 0));
  
  console.log(`🏆 Best variation: ${variations[0].style} (score: ${(variations[0].quality?.score * 100).toFixed(0)}%)`);
  
  return {
    best: variations[0],
    all: variations
  };
}

/**
 * Batch vectorization with progress tracking
 */
async function batchVectorize(images, options = {}) {
  const results = [];
  const total = images.length;
  
  console.log(`📦 Starting batch vectorization of ${total} images...`);
  
  for (let i = 0; i < total; i++) {
    try {
      console.log(`\n[${i + 1}/${total}] Processing...`);
      const result = await vectorizeImage(images[i]);
      results.push({ success: true, data: result });
    } catch (error) {
      console.error(`[${i + 1}/${total}] Failed:`, error.message);
      results.push({ success: false, error: error.message });
    }
    
    // Add delay to avoid rate limiting
    if (i < total - 1 && !isRecraftInCooldown()) {
      await sleep(1000);
    }
  }
  
  const successful = results.filter(r => r.success).length;
  console.log(`\n✅ Batch complete: ${successful}/${total} successful`);
  
  return results;
}

/**
 * Health check for the service
 */
async function healthCheck() {
  const health = {
    ready: true,
    services: {
      recraft: { available: false, inCooldown: false },
      local: { available: false }
    },
    capabilities: Object.keys(VECTORIZATION_PROFILES),
    statistics: connMgr.getStats()
  };
  
  // Check Recraft availability
  if (config.RECRAFT_API_KEY) {
    health.services.recraft.available = true;
    health.services.recraft.inCooldown = isRecraftInCooldown();
    
    if (isRecraftInCooldown()) {
      const remainingMins = Math.ceil((recraftCooldownUntil - Date.now()) / 60000);
      health.services.recraft.cooldownRemaining = `${remainingMins} minutes`;
    }
  }
  
  // Check local vectorization
  health.services.local.available = isLocalVectorizeAvailable();
  
  // Overall readiness
  health.ready = health.services.recraft.available || health.services.local.available;
  
  if (!health.ready) {
    health.error = 'No vectorization service available';
    health.suggestion = 'Configure RECRAFT_API_KEY or install potrace for local vectorization';
  }
  
  return health;
}

/**
 * Clean up connections and resources
 */
function cleanup() {
  connMgr.cleanup();
  console.log('🧹 Recraft service cleaned up');
}

// =============== EXPORTS ===============

module.exports = {
  vectorizeImage,
  vectorizeWithVariations,
  batchVectorize,
  isRecraftInCooldown,
  healthCheck,
  cleanup,
  
  // Export for monitoring
  recraftCooldownUntil: () => recraftCooldownUntil,
  
  // Export for testing/debugging
  _internal: {
    detectStyleFromImage,
    SVGQualityAnalyzer,
    VECTORIZATION_PROFILES,
    connMgr
  },

  // Optional: expose removeBackground if needed elsewhere
  removeBackground: recraftRemoveBackground
};
