// services/inspirationService.js
'use strict';

/**
 * Freepik Inspiration Service
 * Extracts lightweight style features from Freepik illustrations/icons
 * for AI pipeline guidance. Memory-only processing, no image storage.
 */

const axios = require('axios');
const sharp = require('sharp');
const crypto = require('crypto');
const { URL } = require('url');

// Configuration
const CONFIG = {
  SIMILARITY_THRESHOLD: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.92'),
  MAX_CONCURRENT_DOWNLOADS: 3,
  DOWNLOAD_TIMEOUT_MS: 15000,
  MAX_IMAGE_SIZE_MB: 10,
  ALLOWED_DOMAINS: ['freepik.com', 'www.freepik.com', 'img.freepik.com'],
  USER_AGENT: 'Mozilla/5.0 (compatible; VectoriaAI/1.0; Style Analysis Bot)',
  RATE_LIMIT_DELAY_MS: 500, // Delay between requests to respect rate limits
};

// In-memory feature cache (limited size, LRU-style)
class FeatureCache {
  constructor(maxSize = 100) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      ...value,
      cached_at: new Date().toISOString()
    });
  }

  get(key) {
    const value = this.cache.get(key);
    if (value) {
      // Move to end (LRU)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  findSimilar(phash, threshold = CONFIG.SIMILARITY_THRESHOLD) {
    const similar = [];
    for (const [url, features] of this.cache.entries()) {
      if (features.phash) {
        const similarity = this.calculatePHashSimilarity(phash, features.phash);
        if (similarity >= threshold) {
          similar.push({ url, features, similarity });
        }
      }
    }
    return similar;
  }

  calculatePHashSimilarity(hash1, hash2) {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) return 0;
    
    let matches = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] === hash2[i]) matches++;
    }
    return matches / hash1.length;
  }
}

const featureCache = new FeatureCache();

/**
 * Validate if URL is from allowed Freepik domains
 */
function validateFreepikUrl(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    return CONFIG.ALLOWED_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

/**
 * Detect if content is illustration or icon based on URL and metadata
 */
function detectCategory(url, metadata = {}) {
  const urlLower = url.toLowerCase();
  
  // URL-based detection
  if (urlLower.includes('/icon') || urlLower.includes('/icons')) {
    return 'icons';
  }
  if (urlLower.includes('/illustration') || urlLower.includes('/vector')) {
    return 'illustrations';
  }
  
  // Size-based heuristic (icons tend to be square and smaller)
  if (metadata.width && metadata.height) {
    const aspectRatio = metadata.width / metadata.height;
    if (Math.abs(aspectRatio - 1) < 0.1 && metadata.width <= 512) {
      return 'icons';
    }
  }
  
  return 'illustrations'; // Default
}

/**
 * Download image into memory buffer with safety checks
 */
async function downloadToMemory(url) {
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: CONFIG.DOWNLOAD_TIMEOUT_MS,
      maxContentLength: CONFIG.MAX_IMAGE_SIZE_MB * 1024 * 1024,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'image/*',
        'Referer': 'https://www.freepik.com/',
      }
    });
    
    return Buffer.from(response.data);
  } catch (error) {
    console.error(`Failed to download ${url}:`, error.message);
    throw new Error(`Download failed: ${error.message}`);
  }
}

/**
 * Extract color palette from image buffer
 */
async function extractColorPalette(buffer) {
  try {
    // Resize for faster processing
    const processedBuffer = await sharp(buffer)
      .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    
    // Get raw pixel data
    const { data, info } = await sharp(processedBuffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // Simple color quantization
    const colorMap = new Map();
    const pixelCount = info.width * info.height;
    const channels = info.channels;
    
    for (let i = 0; i < data.length; i += channels) {
      // Quantize to reduce color space
      const r = Math.round(data[i] / 32) * 32;
      const g = Math.round(data[i + 1] / 32) * 32;
      const b = Math.round(data[i + 2] / 32) * 32;
      const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      
      colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
    }
    
    // Sort by frequency and get top colors
    const sortedColors = Array.from(colorMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([color]) => color);
    
    // Calculate dominant color (most frequent)
    const dominant = sortedColors[0] || '#000000';
    
    return {
      palette: sortedColors,
      dominant: dominant
    };
  } catch (error) {
    console.error('Color extraction failed:', error);
    return {
      palette: ['#000000'],
      dominant: '#000000'
    };
  }
}

/**
 * Calculate image statistics for style analysis
 */
async function calculateImageStats(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const pixels = data.length;
    let sum = 0;
    let min = 255;
    let max = 0;
    
    // Calculate brightness
    for (let i = 0; i < pixels; i++) {
      const value = data[i];
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    
    const brightness = sum / pixels / 255; // Normalized to 0-1
    const contrast = (max - min) / 255; // Normalized to 0-1
    
    // Calculate edge density using simple gradient
    let edges = 0;
    const threshold = 30;
    
    for (let y = 1; y < info.height - 1; y++) {
      for (let x = 1; x < info.width - 1; x++) {
        const idx = y * info.width + x;
        const current = data[idx];
        
        // Simple Sobel-like edge detection
        const dx = Math.abs(current - data[idx + 1]);
        const dy = Math.abs(current - data[idx + info.width]);
        
        if (dx > threshold || dy > threshold) {
          edges++;
        }
      }
    }
    
    const edgeDensity = edges / (info.width * info.height); // Normalized
    
    // Determine vector complexity based on edge density
    let vectorComplexity = 'low';
    if (edgeDensity > 0.15) vectorComplexity = 'high';
    else if (edgeDensity > 0.08) vectorComplexity = 'moderate';
    
    return {
      brightness,
      contrast,
      edge_density: edgeDensity,
      vector_complexity_hint: vectorComplexity,
      dimensions: { width: info.width, height: info.height }
    };
  } catch (error) {
    console.error('Stats calculation failed:', error);
    return {
      brightness: 0.5,
      contrast: 0.5,
      edge_density: 0.1,
      vector_complexity_hint: 'moderate',
      dimensions: { width: 0, height: 0 }
    };
  }
}

/**
 * Generate perceptual hash for similarity detection
 */
async function generatePHash(buffer) {
  try {
    // Resize to 32x32 and convert to greyscale
    const processed = await sharp(buffer)
      .resize(32, 32, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    
    // Calculate mean
    let sum = 0;
    for (let i = 0; i < processed.length; i++) {
      sum += processed[i];
    }
    const mean = sum / processed.length;
    
    // Generate hash
    let hash = '';
    for (let i = 0; i < processed.length; i += 4) {
      const bit = processed[i] > mean ? '1' : '0';
      hash += bit;
    }
    
    // Convert binary string to hex
    let hexHash = '';
    for (let i = 0; i < hash.length; i += 8) {
      const byte = hash.substr(i, 8);
      hexHash += parseInt(byte, 2).toString(16).padStart(2, '0');
    }
    
    return hexHash;
  } catch (error) {
    console.error('PHash generation failed:', error);
    // Return a random hash as fallback
    return crypto.randomBytes(32).toString('hex');
  }
}

/**
 * Extract all style features from a single image
 */
async function extractFeaturesFromBuffer(buffer, url) {
  // Check cache first
  const cached = featureCache.get(url);
  if (cached) {
    console.log(`Using cached features for ${url}`);
    return cached;
  }
  
  // Extract all features in parallel where possible
  const [colorData, stats, phash, metadata] = await Promise.all([
    extractColorPalette(buffer),
    calculateImageStats(buffer),
    generatePHash(buffer),
    sharp(buffer).metadata()
  ]);
  
  const category = detectCategory(url, metadata);
  
  const features = {
    source_url: url,
    category: category,
    palette: colorData.palette,
    dominant: colorData.dominant,
    brightness: stats.brightness,
    contrast: stats.contrast,
    edge_density: stats.edge_density,
    vector_complexity_hint: stats.vector_complexity_hint,
    phash: phash,
    extracted_at: new Date().toISOString(),
    dimensions: stats.dimensions
  };
  
  // Cache the features
  featureCache.set(url, features);
  
  return features;
}

/**
 * Process multiple URLs with rate limiting
 */
async function processUrls(urls) {
  const results = [];
  const errors = [];
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    
    try {
      // Validate URL
      if (!validateFreepikUrl(url)) {
        throw new Error('Invalid Freepik URL');
      }
      
      console.log(`Processing ${i + 1}/${urls.length}: ${url}`);
      
      // Download to memory
      const buffer = await downloadToMemory(url);
      
      // Extract features
      const features = await extractFeaturesFromBuffer(buffer, url);
      results.push(features);
      
      // Clear buffer from memory (explicit for GC)
      buffer.fill(0);
      
      // Rate limiting delay (except for last item)
      if (i < urls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY_MS));
      }
      
    } catch (error) {
      console.error(`Error processing ${url}:`, error.message);
      errors.push({
        url: url,
        error: error.message
      });
    }
  }
  
  return { results, errors };
}

/**
 * Generate style recipe based on extracted features
 */
function generateStyleRecipe(features) {
  if (!features || features.length === 0) {
    throw new Error('No features to generate recipe from');
  }
  
  // Analyze collective characteristics
  const categories = features.map(f => f.category);
  const isMainlyIcons = categories.filter(c => c === 'icons').length > categories.length / 2;
  
  // Calculate averages
  const avgBrightness = features.reduce((sum, f) => sum + f.brightness, 0) / features.length;
  const avgContrast = features.reduce((sum, f) => sum + f.contrast, 0) / features.length;
  const avgEdgeDensity = features.reduce((sum, f) => sum + f.edge_density, 0) / features.length;
  
  // Collect all colors and find most common
  const allColors = features.flatMap(f => f.palette);
  const colorFrequency = {};
  allColors.forEach(color => {
    colorFrequency[color] = (colorFrequency[color] || 0) + 1;
  });
  const commonColors = Object.entries(colorFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([color]) => color);
  
  // Determine complexity
  const complexities = features.map(f => f.vector_complexity_hint);
  const mainComplexity = complexities.sort((a, b) => 
    complexities.filter(c => c === b).length - complexities.filter(c => c === a).length
  )[0];
  
  // Generate style prompt
  let stylePrompt = '';
  if (isMainlyIcons) {
    stylePrompt = 'Clean, minimalist icon design with sharp edges and limited colors';
  } else {
    if (avgBrightness > 0.7) {
      stylePrompt = 'Bright, vibrant illustration with ';
    } else if (avgBrightness < 0.3) {
      stylePrompt = 'Dark, moody illustration with ';
    } else {
      stylePrompt = 'Balanced illustration with ';
    }
    
    if (avgEdgeDensity > 0.15) {
      stylePrompt += 'intricate details and complex patterns';
    } else if (avgEdgeDensity < 0.05) {
      stylePrompt += 'simple shapes and clean lines';
    } else {
      stylePrompt += 'moderate detail and structured composition';
    }
  }
  
  // Determine Recraft profile
  let recraftProfile = 'default';
  if (isMainlyIcons || avgEdgeDensity < 0.05) {
    recraftProfile = 'minimal';
  } else if (avgEdgeDensity > 0.12 && avgContrast > 0.6) {
    recraftProfile = 'geometric';
  } else if (avgEdgeDensity > 0.08 && avgBrightness > 0.6) {
    recraftProfile = 'organic';
  }
  
  // Set SVG constraints
  const svgConstraints = {
    max_colors: isMainlyIcons ? 4 : Math.min(8, commonColors.length + 2),
    merge_paths: isMainlyIcons || mainComplexity === 'low',
    float_precision: mainComplexity === 'high' ? 3 : 2,
    simplify_paths: mainComplexity === 'low',
    optimize_transforms: true
  };
  
  return {
    style_prompt: stylePrompt,
    recraft_profile: recraftProfile,
    svg_constraints: svgConstraints,
    derived_from: {
      urls: features.map(f => f.source_url),
      dominant_colors: commonColors.slice(0, 3),
      avg_brightness: avgBrightness.toFixed(2),
      avg_contrast: avgContrast.toFixed(2),
      avg_edge_density: avgEdgeDensity.toFixed(3),
      main_category: isMainlyIcons ? 'icons' : 'illustrations',
      main_complexity: mainComplexity
    }
  };
}

/**
 * Check similarity between generated output and inspiration sources
 */
async function checkSimilarity(outputBuffer, inspirationUrls = []) {
  try {
    // Generate hash for output
    const outputHash = await generatePHash(outputBuffer);
    
    // Check against cached inspiration features
    const similarities = [];
    
    for (const url of inspirationUrls) {
      const features = featureCache.get(url);
      if (features && features.phash) {
        const similarity = featureCache.calculatePHashSimilarity(outputHash, features.phash);
        if (similarity >= CONFIG.SIMILARITY_THRESHOLD) {
          similarities.push({
            source_url: url,
            similarity: similarity,
            threshold: CONFIG.SIMILARITY_THRESHOLD
          });
        }
      }
    }
    
    // Also check against all cached items
    const cachedSimilar = featureCache.findSimilar(outputHash, CONFIG.SIMILARITY_THRESHOLD);
    cachedSimilar.forEach(item => {
      if (!similarities.find(s => s.source_url === item.url)) {
        similarities.push({
          source_url: item.url,
          similarity: item.similarity,
          threshold: CONFIG.SIMILARITY_THRESHOLD
        });
      }
    });
    
    return {
      is_too_similar: similarities.length > 0,
      similarities: similarities,
      output_phash: outputHash,
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    console.error('Similarity check failed:', error);
    return {
      is_too_similar: false,
      similarities: [],
      error: error.message
    };
  }
}

/**
 * Apply style adjustments to reduce similarity
 */
function generateAdjustmentStrategy(similarities) {
  const strategies = [];
  
  if (similarities.length > 0) {
    const maxSimilarity = Math.max(...similarities.map(s => s.similarity));
    
    if (maxSimilarity > 0.95) {
      // Very high similarity - apply strong adjustments
      strategies.push({
        action: 'color_shift',
        params: { hue_rotate: 60, saturation_adjust: -0.2 }
      });
      strategies.push({
        action: 'merge_paths',
        params: { aggressive: true }
      });
    } else if (maxSimilarity > CONFIG.SIMILARITY_THRESHOLD) {
      // Moderate similarity - apply lighter adjustments
      strategies.push({
        action: 'color_variation',
        params: { secondary_color_change: true }
      });
      strategies.push({
        action: 'simplify',
        params: { reduction: 0.1 }
      });
    }
  }
  
  return strategies;
}

// =============== EXPRESS ROUTE HANDLERS ===============

/**
 * POST /api/inspiration/extract
 * Extract style features from Freepik URLs
 */
async function extractInspiration(req, res) {
  try {
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide an array of Freepik URLs'
      });
    }
    
    if (urls.length > 10) {
      return res.status(400).json({
        error: 'Too many URLs',
        message: 'Maximum 10 URLs allowed per request'
      });
    }
    
    // Process URLs
    const { results, errors } = await processUrls(urls);
    
    // Filter out non-illustration/icon content
    const validResults = results.filter(r => 
      r.category === 'illustrations' || r.category === 'icons'
    );
    
    if (validResults.length === 0 && errors.length === 0) {
      return res.status(400).json({
        error: 'No valid content',
        message: 'URLs must point to Freepik illustrations or icons'
      });
    }
    
    res.json({
      success: true,
      features: validResults,
      errors: errors,
      metadata: {
        total_processed: urls.length,
        successful: validResults.length,
        failed: errors.length,
        processed_at: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Extract inspiration error:', error);
    res.status(500).json({
      error: 'Processing failed',
      message: error.message
    });
  }
}

/**
 * POST /api/inspiration/recipe
 * Generate style recipe from Freepik URLs
 */
async function generateRecipe(req, res) {
  try {
    const { urls } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide an array of Freepik URLs'
      });
    }
    
    // First extract features
    const { results, errors } = await processUrls(urls);
    
    const validResults = results.filter(r => 
      r.category === 'illustrations' || r.category === 'icons'
    );
    
    if (validResults.length === 0) {
      return res.status(400).json({
        error: 'No valid content',
        message: 'Could not extract features from provided URLs',
        errors: errors
      });
    }
    
    // Generate recipe
    const recipe = generateStyleRecipe(validResults);
    
    res.json({
      success: true,
      recipe: recipe,
      features_extracted: validResults.length,
      errors: errors,
      generated_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Generate recipe error:', error);
    res.status(500).json({
      error: 'Recipe generation failed',
      message: error.message
    });
  }
}

/**
 * POST /api/inspiration/check-similarity
 * Check if generated output is too similar to inspiration
 */
async function checkOutputSimilarity(req, res) {
  try {
    const { output_url, inspiration_urls } = req.body;
    
    if (!output_url) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Please provide output_url'
      });
    }
    
    // Download output image
    const outputBuffer = await downloadToMemory(output_url);
    
    // Check similarity
    const similarityResult = await checkSimilarity(outputBuffer, inspiration_urls || []);
    
    // Generate adjustment strategies if too similar
    let adjustments = [];
    if (similarityResult.is_too_similar) {
      adjustments = generateAdjustmentStrategy(similarityResult.similarities);
    }
    
    res.json({
      ...similarityResult,
      adjustments: adjustments,
      recommendation: similarityResult.is_too_similar 
        ? 'Apply adjustments and regenerate' 
        : 'Output is sufficiently unique'
    });
    
    // Clear buffer
    outputBuffer.fill(0);
    
  } catch (error) {
    console.error('Similarity check error:', error);
    res.status(500).json({
      error: 'Similarity check failed',
      message: error.message
    });
  }
}

/**
 * GET /api/inspiration/cache-info
 * Get information about cached features
 */
function getCacheInfo(req, res) {
  const cacheInfo = {
    size: featureCache.cache.size,
    max_size: featureCache.maxSize,
    items: Array.from(featureCache.cache.entries()).map(([url, features]) => ({
      url: url,
      category: features.category,
      cached_at: features.cached_at,
      phash: features.phash.substring(0, 8) + '...' // Truncate for display
    }))
  };
  
  res.json(cacheInfo);
}

/**
 * POST /api/inspiration/clear-cache
 * Clear the feature cache
 */
function clearCache(req, res) {
  const previousSize = featureCache.cache.size;
  featureCache.cache.clear();
  
  res.json({
    success: true,
    message: 'Cache cleared',
    items_cleared: previousSize
  });
}

  module.exports = {
  extractInspiration,
  generateRecipe,
  checkOutputSimilarity,
  getCacheInfo,
  clearCache,
  
  // Export internal functions for direct use
  _internal: {
    validateFreepikUrl,
    detectCategory,
    extractFeaturesFromBuffer,
    generateStyleRecipe,
    checkSimilarity,
    featureCache,
    processUrls,  // ADD THIS LINE - now processUrls is exported
    generateAdjustmentStrategy  // ADD THIS LINE - useful for adjustments
  }
};