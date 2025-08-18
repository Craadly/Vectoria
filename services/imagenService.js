// services/imagenService.js
'use strict';

/**
 * Enhanced Imagen service with super intelligence for SVG-optimized raster generation.
 * Produces images specifically designed for high-quality vectorization.
 */

const http = require('http');
const https = require('https');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sharp = require('sharp'); // Add this to package.json if not present
const config = require('../config/env');

// ---------- Enhanced Tunables ----------
const DEFAULT_TIMEOUT_MS = Number(process.env.IMAGEN_HTTP_TIMEOUT_MS || 60_000);
const USER_AGENT = process.env.IMAGEN_USER_AGENT || 'Craadly-Vectoria/2.0-Enhanced';

// SVG-optimized generation parameters
// Imagen 4.0 supports: 1024x1024, 1024x768, 768x1024
const SVG_OPTIMIZATION_PROFILES = {
  logo: {
    aspectRatio: '1:1',
    sampleImageSize: '1024', // Imagen 4.0 only supports 1024x1024 for 1:1
    styleModifiers: 'corporate, professional, scalable, iconic',
    negativePrompt: 'complex textures, photorealistic, 3d render, gradients, shadows, busy background, noise, grain, blur, soft edges, watermark, text, realistic lighting, depth of field, bokeh',
    postProcessing: {
      contrast: 1.3,
      brightness: 1.1,
      sharpen: true,
      simplify: true
    }
  },
  minimal: {
    aspectRatio: '1:1',
    sampleImageSize: '1024',
    styleModifiers: 'ultra minimalist, few elements, high contrast, clean edges',
    negativePrompt: 'complex, detailed, textured, gradient, shadow, 3d, photorealistic, busy, cluttered, ornate, decorative, realistic, soft edges',
    postProcessing: {
      contrast: 1.5,
      brightness: 1.2,
      sharpen: true,
      threshold: 180
    }
  },
  geometric: {
    aspectRatio: '1:1',
    sampleImageSize: '1024',
    styleModifiers: 'precise geometric shapes, mathematical, angular, symmetrical',
    negativePrompt: 'organic, curved, natural, photorealistic, textured, gradient, shadow, 3d render, soft, blurry, imprecise',
    postProcessing: {
      contrast: 1.4,
      sharpen: true,
      edgeEnhance: true
    }
  },
  character: {
    aspectRatio: '1:1',
    sampleImageSize: '1024',
    styleModifiers: 'cartoon character, bold outlines, simple shapes, flat colors',
    negativePrompt: 'realistic, photographic, 3d render, complex shading, gradient, texture, detailed features, realistic proportions, soft edges',
    postProcessing: {
      contrast: 1.3,
      saturation: 1.2,
      sharpen: true,
      smoothing: true
    }
  },
  technical: {
    aspectRatio: '1:1',
    sampleImageSize: '1024', // Use max supported size
    styleModifiers: 'technical drawing, blueprint style, precise lines, schematic',
    negativePrompt: 'artistic, painterly, photorealistic, textured, gradient, shadow, 3d, perspective, soft edges, blur',
    postProcessing: {
      contrast: 1.6,
      monochrome: true,
      sharpen: true,
      edgeEnhance: true
    }
  },
  organic: {
    aspectRatio: '1:1',
    sampleImageSize: '1024',
    styleModifiers: 'smooth curves, flowing shapes, natural forms, simplified',
    negativePrompt: 'photorealistic, detailed texture, complex, gradient, shadow, 3d render, busy, cluttered, geometric, angular',
    postProcessing: {
      contrast: 1.2,
      smoothing: true,
      simplify: true
    }
  },
  default: {
    aspectRatio: '1:1',
    sampleImageSize: '1024',
    styleModifiers: 'vector-ready, high contrast, clear shapes, simple',
    negativePrompt: 'photorealistic, 3d render, gradient, shadow, texture, complex background, photograph, realistic, detailed textures, noise, grain, blur, soft edges, watermark, text',
    postProcessing: {
      contrast: 1.3,
      brightness: 1.05,
      sharpen: true
    }
  }
};

// Color analysis for better vectorization
const COLOR_COMPLEXITY_LIMITS = {
  simple: 4,    // 2-4 colors
  moderate: 8,  // 5-8 colors
  complex: 16   // 9-16 colors
};

// ---------- Connection pooling ----------
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

const axiosInstance = axios.create({
  timeout: DEFAULT_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  maxRedirects: 5,
  headers: { 'User-Agent': USER_AGENT },
  validateStatus: (s) => s >= 200 && s < 300,
});

// ---------- Google Auth ----------
let googleAuthClient = null;
let initPromise = null;

async function initializeGoogleAuth() {
  if (googleAuthClient) return googleAuthClient;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log('🔐 Initializing Google Auth for Imagen...');
      const keyFilePath = path.join(__dirname, '..', 'service-account-key.json');

      if (!fs.existsSync(keyFilePath)) {
        console.error(`❌ FATAL: Credentials file not found at: ${keyFilePath}`);
        return null;
      }

      const auth = new GoogleAuth({
        keyFilename: keyFilePath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });

      googleAuthClient = await auth.getClient();
      console.log('✅ Google Auth initialized successfully.');
      return googleAuthClient;
    } catch (error) {
      console.error('❌ Google Auth initialization error:', error.message);
      googleAuthClient = null;
      return null;
    }
  })();

  return initPromise;
}

function isGoogleAuthInitialized() {
  return !!googleAuthClient;
}

// ---------- Enhanced Helper Functions ----------

/**
 * Detect the style from the enhanced prompt to choose optimization profile
 */
function detectStyleFromPrompt(prompt) {
  const lower = prompt.toLowerCase();
  
  // Check for specific style indicators
  if (lower.includes('logo') || lower.includes('brand') || lower.includes('symbol')) {
    return 'logo';
  }
  if (lower.includes('minimal') || lower.includes('simple') || lower.includes('clean')) {
    return 'minimal';
  }
  if (lower.includes('geometric') || lower.includes('angular') || lower.includes('polygon')) {
    return 'geometric';
  }
  if (lower.includes('character') || lower.includes('mascot') || lower.includes('cartoon')) {
    return 'character';
  }
  if (lower.includes('technical') || lower.includes('blueprint') || lower.includes('schematic')) {
    return 'technical';
  }
  if (lower.includes('organic') || lower.includes('flowing') || lower.includes('natural')) {
    return 'organic';
  }
  
  return 'default';
}

/**
 * Enhance prompt specifically for better vectorization results
 */
function enhancePromptForVectorization(prompt, style) {
  const profile = SVG_OPTIMIZATION_PROFILES[style];
  
  // Add style-specific modifiers
  let enhanced = prompt;
  if (!enhanced.includes(profile.styleModifiers)) {
    enhanced = `${prompt}, ${profile.styleModifiers}`;
  }
  
  // Add vectorization-friendly keywords
  const vectorKeywords = [
    'clear boundaries',
    'distinct shapes',
    'solid colors',
    'high contrast',
    'centered composition',
    'white background',
    'no ambiguous edges'
  ];
  
  // Add keywords that aren't already present
  const missingKeywords = vectorKeywords.filter(keyword => 
    !enhanced.toLowerCase().includes(keyword.toLowerCase())
  );
  
  if (missingKeywords.length > 0) {
    enhanced += ', ' + missingKeywords.join(', ');
  }
  
  return enhanced;
}

/**
 * Post-process image for optimal vectorization using sharp
 */
async function postProcessForVectorization(imageBuffer, style) {
  try {
    // Skip if sharp is not available
    if (!sharp) {
      console.log('⚠️ Sharp not available, skipping post-processing');
      return imageBuffer;
    }
    
    const profile = SVG_OPTIMIZATION_PROFILES[style];
    const processing = profile.postProcessing;
    
    let image = sharp(imageBuffer);
    
    // Get image metadata
    const metadata = await image.metadata();
    console.log(`📊 Processing ${metadata.width}x${metadata.height} image for style: ${style}`);
    
    // Apply contrast and brightness adjustments
    if (processing.contrast || processing.brightness) {
      image = image.modulate({
        brightness: processing.brightness || 1,
        saturation: processing.saturation || 1
      });
    }
    
    // Apply sharpening for better edges
    if (processing.sharpen) {
      image = image.sharpen({
        sigma: 1.5,
        m1: 1.0,
        m2: 0.5
      });
    }
    
    // Edge enhancement for geometric styles
    if (processing.edgeEnhance) {
      image = image.convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 9, -1, -1, -1, -1] // Edge enhancement kernel
      });
    }
    
    // Convert to monochrome for technical drawings
    if (processing.monochrome) {
      image = image.greyscale();
      if (processing.threshold) {
        image = image.threshold(processing.threshold);
      }
    }
    
    // Reduce colors for simpler vectorization
    if (processing.simplify) {
      // Posterize effect - reduce color depth
      image = image.png({ 
        colors: style === 'minimal' ? 8 : 16,
        dither: false 
      });
    }
    
    // Apply smoothing for character/organic styles
    if (processing.smoothing) {
      image = image.median(3); // 3x3 median filter for smoothing
    }
    
    // Ensure high quality output
    const processedBuffer = await image
      .png({ 
        compressionLevel: 0, // No compression for quality
        adaptiveFiltering: false,
        palette: false
      })
      .toBuffer();
    
    console.log(`✅ Post-processing complete for ${style} style`);
    return processedBuffer;
    
  } catch (error) {
    console.warn('⚠️ Post-processing failed, using original:', error.message);
    return imageBuffer;
  }
}

/**
 * Analyze image for vectorization readiness
 */
async function analyzeVectorizationReadiness(imageBuffer) {
  try {
    if (!sharp) return { ready: true, score: 0.5, suggestions: [] };
    
    const image = sharp(imageBuffer);
    const { entropy, sharpness } = await image.stats();
    const metadata = await image.metadata();
    
    const analysis = {
      ready: true,
      score: 1.0,
      suggestions: [],
      metrics: {
        entropy: entropy,
        sharpness: sharpness,
        dimensions: `${metadata.width}x${metadata.height}`,
        format: metadata.format
      }
    };
    
    // Check entropy (complexity)
    if (entropy > 7) {
      analysis.score -= 0.3;
      analysis.suggestions.push('Image may be too complex for clean vectorization');
    }
    
    // Check sharpness
    if (sharpness < 0.5) {
      analysis.score -= 0.2;
      analysis.suggestions.push('Image edges may be too soft');
    }
    
    // Check dimensions
    if (metadata.width < 512 || metadata.height < 512) {
      analysis.score -= 0.1;
      analysis.suggestions.push('Higher resolution recommended for better vectorization');
    }
    
    analysis.ready = analysis.score > 0.3;
    
    return analysis;
  } catch (error) {
    console.warn('⚠️ Could not analyze image:', error.message);
    return { ready: true, score: 0.5, suggestions: [] };
  }
}

async function ensureTempDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function buildEndpoint() {
  if (!config.GOOGLE_PROJECT_ID) {
    throw new Error('GOOGLE_PROJECT_ID is not configured.');
  }
  const loc = config.GOOGLE_LOCATION || 'us-central1';
  const model = config.IMAGEN_MODEL_ID || 'imagen-4.0-generate-001';
  return `https://${loc}-aiplatform.googleapis.com/v1/projects/${config.GOOGLE_PROJECT_ID}/locations/${loc}/publishers/google/models/${model}:predict`;
}

function summarizeAxiosError(err) {
  const status = err?.response?.status;
  let data = err?.response?.data;
  try {
    if (typeof data === 'string' && /^[\[{"]/.test(data)) data = JSON.parse(data);
  } catch {}
  const hint =
    (data && (data.error?.message || data.message || data.detail)) ||
    err?.message ||
    String(err);
  return { status, hint };
}

// ---------- Enhanced Public API ----------

/**
 * Generate a PNG raster optimized for SVG vectorization using Google Imagen.
 * @param {string} prompt - The enhanced prompt from geminiService
 * @param {object} [options={}] - Optional parameters for generation
 * @param {string} [options.style] - Detected style for optimization
 * @param {string} [options.aspectRatio] - Aspect ratio
 * @param {number} [options.sampleCount] - Number of images to generate
 * @param {boolean} [options.skipPostProcessing] - Skip post-processing
 * @param {boolean} [options.analyze] - Include vectorization readiness analysis
 * @returns {Promise<{imageUrl, imagePath, imageBuffer, style, analysis?, prompt}>}
 */
async function generateImage(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Prompt is required and must be a string.');
  }

  // Detect style from prompt if not provided
  const style = options.style || detectStyleFromPrompt(prompt);
  const profile = SVG_OPTIMIZATION_PROFILES[style] || SVG_OPTIMIZATION_PROFILES.default;
  
  console.log(`🎨 Generating image with style profile: ${style}`);
  
  // Enhance prompt for better vectorization
  const enhancedPrompt = enhancePromptForVectorization(prompt, style);
  console.log(`📝 Enhanced prompt for vectorization: ${enhancedPrompt.substring(0, 100)}...`);

  // Ensure auth is ready
  const client = await initializeGoogleAuth();
  if (!client) {
    throw new Error('Google Auth client failed to initialize. Check service account credentials.');
  }

  // Obtain Bearer token
  let token;
  try {
    const accessToken = await client.getAccessToken();
    token = accessToken.token;
    if (!token) {
      throw new Error('null token received from Google Auth');
    }
  } catch (err) {
    console.error('❌ Failed to obtain Google access token:', err.message);
    throw new Error('Could not get Google access token. Check IAM permissions.');
  }

  const endpoint = buildEndpoint();

  // Build parameters with style-specific optimizations
  const parameters = {
    sampleCount: options.sampleCount || 1,
    aspectRatio: options.aspectRatio || profile.aspectRatio,
    // IMPORTANT: Don't send sampleImageSize parameter - let Imagen use defaults
    addWatermark: false,
    negativePrompt: options.negativePrompt || profile.negativePrompt,
    // Add style-specific parameters
    guidanceScale: style === 'technical' ? 12 : (style === 'minimal' ? 10 : 7.5),
    seed: options.seed || Math.floor(Math.random() * 1000000)
  };
  
  // Only add sampleImageSize if explicitly provided and valid
  if (options.sampleImageSize && ['1024', '768'].includes(options.sampleImageSize)) {
    parameters.sampleImageSize = options.sampleImageSize;
  }

  const requestBody = {
    instances: [{ prompt: enhancedPrompt }],
    parameters,
  };

  try {
    console.log(`🚀 Sending request to Imagen API...`);
    const startTime = Date.now();
    
    const response = await axiosInstance.post(endpoint, requestBody, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const prediction = response.data?.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      throw new Error('Invalid response from Imagen API (no image data).');
    }

    console.log(`⏱️ Imagen API responded in ${Date.now() - startTime}ms`);

    let imageBuffer = Buffer.from(prediction.bytesBase64Encoded, 'base64');
    
    // Post-process for better vectorization unless skipped
    if (!options.skipPostProcessing) {
      console.log(`🔧 Applying ${style} post-processing optimizations...`);
      imageBuffer = await postProcessForVectorization(imageBuffer, style);
    }
    
    // Analyze vectorization readiness if requested
    let analysis = null;
    if (options.analyze) {
      console.log(`🔍 Analyzing vectorization readiness...`);
      analysis = await analyzeVectorizationReadiness(imageBuffer);
      console.log(`📊 Vectorization score: ${(analysis.score * 100).toFixed(0)}%`);
      if (analysis.suggestions.length > 0) {
        console.log(`💡 Suggestions: ${analysis.suggestions.join(', ')}`);
      }
    }

    // Save to temp directory
    await ensureTempDir(config.TEMP_DIR);
    const fileName = `imagen_${style}_${Date.now()}.png`;
    const filePath = path.join(config.TEMP_DIR, fileName);
    await fsp.writeFile(filePath, imageBuffer);

    console.log(`✅ Image saved: ${fileName} (${(imageBuffer.length / 1024).toFixed(1)}KB)`);

    return {
      imageUrl: `/temp/${fileName}`,
      imagePath: filePath,
      imageBuffer,
      style,
      analysis,
      prompt: enhancedPrompt,
      metadata: {
        originalPrompt: prompt,
        profile: style,
        parameters,
        timestamp: new Date().toISOString()
      }
    };
    
  } catch (err) {
    const info = summarizeAxiosError(err);
    console.error(
      `❌ Imagen API request failed${info.status ? ` (HTTP ${info.status})` : ''}: ${info.hint}`
    );
    
    // Provide more specific error messages
    if (info.status === 403) {
      throw new Error('Permission denied. Check if Imagen API is enabled and service account has correct permissions.');
    } else if (info.status === 429) {
      throw new Error('Rate limit exceeded. Please try again later.');
    } else if (info.status === 400) {
      throw new Error(`Invalid request: ${info.hint}. Check prompt and parameters.`);
    }
    
    throw new Error(`Imagen API error (HTTP ${info.status || 'N/A'}): ${info.hint || 'Request failed'}`);
  }
}

/**
 * Generate multiple variations for better vectorization options
 */
async function generateVariations(prompt, count = 3, options = {}) {
  console.log(`🎭 Generating ${count} variations for better vectorization options...`);
  
  const variations = [];
  const styles = ['minimal', 'geometric', 'default'];
  
  for (let i = 0; i < Math.min(count, styles.length); i++) {
    try {
      const result = await generateImage(prompt, {
        ...options,
        style: styles[i],
        seed: Math.floor(Math.random() * 1000000)
      });
      variations.push(result);
      console.log(`✅ Variation ${i + 1}/${count} generated (${styles[i]} style)`);
    } catch (error) {
      console.warn(`⚠️ Variation ${i + 1} failed:`, error.message);
    }
  }
  
  if (variations.length === 0) {
    throw new Error('Failed to generate any variations');
  }
  
  // Return the best variation based on analysis scores
  if (options.analyze) {
    variations.sort((a, b) => (b.analysis?.score || 0) - (a.analysis?.score || 0));
    console.log(`🏆 Best variation: ${variations[0].style} (score: ${(variations[0].analysis?.score * 100).toFixed(0)}%)`);
  }
  
  return variations;
}

/**
 * Check if the service is ready for generation
 */
async function healthCheck() {
  try {
    const client = await initializeGoogleAuth();
    if (!client) {
      return { 
        ready: false, 
        error: 'Google Auth not initialized',
        suggestion: 'Check service-account-key.json file'
      };
    }
    
    const token = await client.getAccessToken();
    if (!token?.token) {
      return { 
        ready: false, 
        error: 'Cannot obtain access token',
        suggestion: 'Check service account IAM permissions'
      };
    }
    
    return { 
      ready: true, 
      message: 'Imagen service is ready',
      capabilities: Object.keys(SVG_OPTIMIZATION_PROFILES)
    };
    
  } catch (error) {
    return { 
      ready: false, 
      error: error.message,
      suggestion: 'Check configuration and credentials'
    };
  }
}

// Kick off auth initialization at module load
initializeGoogleAuth().catch(() => { /* error logged in function */ });

module.exports = {
  generateImage,
  generateVariations,
  isGoogleAuthInitialized,
  healthCheck,
  // Export for testing/debugging
  _internal: {
    detectStyleFromPrompt,
    enhancePromptForVectorization,
    SVG_OPTIMIZATION_PROFILES
  }
};