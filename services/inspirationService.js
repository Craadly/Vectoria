// services/inspirationService.js
'use strict';

/**
 * Freepik Inspiration Service
 * Extracts lightweight style features from Freepik illustrations/icons
 * for AI pipeline guidance. Uses the official Freepik API for downloading.
 */

const axios = require('axios');
const sharp = require('sharp');
const crypto = require('crypto');
const { URL } = require('url');
const config = require('../config/env'); // Import config to access API key

// Configuration
const CONFIG = {
  SIMILARITY_THRESHOLD: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.92'),
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
 * Extracts the resource ID from a Freepik URL.
 * @param {string} urlString - The Freepik URL.
 * @returns {string|null} The resource ID or null if not found.
 */
function extractResourceIdFromUrl(urlString) {
    try {
      const url = new URL(urlString);
      // Look for patterns like /free-vector/pink-gradient_5516204.htm
      const match = url.pathname.match(/_(\d+)\.htm/);
      if (match && match[1]) {
        return match[1];
      }
      return null;
    } catch {
      return null;
    }
}

/**
 * Download image into memory buffer with safety checks using the Freepik API.
 * This version includes enhanced error logging.
 */
async function downloadToMemory(url) {
    const resourceId = extractResourceIdFromUrl(url);
    if (!resourceId) {
        throw new Error(`Could not extract a resource ID from the URL: ${url}`);
    }

    const apiKey = config.FREEPIK_API_KEY; // Using the config module
    if (!apiKey || apiKey === "YOUR_API_KEY_HERE") {
        throw new Error('Freepik API key is missing or invalid. Please add FREEPIK_API_KEY to your .env file.');
    }

    try {
        // Step 1: Get the temporary download URL from the Freepik API
        console.log(`[Inspiration] Requesting download URL for resource ${resourceId}`);
        const apiResponse = await axios({
            method: 'GET',
            url: `https://api.freepik.com/v1/resources/${resourceId}/download`,
            headers: {
                'x-freepik-api-key': apiKey,
                'Accept': 'application/json'
            }
        });

        const downloadUrl = apiResponse.data?.data?.url;
        if (!downloadUrl) {
            throw new Error('Could not get a download URL from the Freepik API. The response may not contain a URL.');
        }

        // Step 2: Download the image from the temporary URL provided by the API
        console.log(`[Inspiration] Downloading image from temporary URL...`);
        const imageResponse = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'arraybuffer',
            timeout: CONFIG.DOWNLOAD_TIMEOUT_MS,
            maxContentLength: CONFIG.MAX_IMAGE_SIZE_MB * 1024 * 1024,
            headers: {
                'User-Agent': CONFIG.USER_AGENT,
                'Accept': 'image/*',
            }
        });

        return Buffer.from(imageResponse.data);
    } catch (error) {
        console.error(`[Inspiration] Failed to download ${url}:`, error.message);
        // **Enhanced Error Logging**
        if (error.response) {
            console.error('Freepik API Error Details:', {
                status: error.response.status,
                data: error.response.data,
                headers: error.response.headers,
            });
            
            // Handle specific error cases
            if (error.response.status === 403) {
                const errorData = error.response.data;
                if (errorData?.data?.message?.includes('Premium users') || 
                    errorData?.message?.includes('Premium users') ||
                    errorData?.error?.includes('Premium')) {
                    throw new Error('PREMIUM_CONTENT_RESTRICTION: This asset requires a Freepik Premium subscription. Please try a different image or upgrade your Freepik API plan.');
                }
                throw new Error('ACCESS_DENIED: You do not have permission to access this resource. Please check your API key permissions.');
            }
            
            if (error.response.status === 429) {
                throw new Error('RATE_LIMIT_EXCEEDED: Too many requests. Please wait a moment before trying again.');
            }
            
            if (error.response.status === 404) {
                throw new Error('RESOURCE_NOT_FOUND: The requested Freepik resource was not found. Please check the URL.');
            }
            
            const apiError = error.response.data?.error?.message || 
                           error.response.data?.data?.message || 
                           error.response.data?.message ||
                           JSON.stringify(error.response.data);
            throw new Error(`Freepik API Error (${error.response.status}): ${apiError}`);
        }
        throw new Error(`Download failed: ${error.message}`);
    }
}

/**
 * Load a raster image from a direct URL (arraybuffer fetch). Does not require Freepik resource id.
 * Useful when we already have a signed temporary URL from Freepik API, or a thumbnail URL.
 */
async function loadRasterFromUrl(directUrl) {
  try {
    const imageResponse = await axios({
      method: 'GET',
      url: directUrl,
      responseType: 'arraybuffer',
      timeout: CONFIG.DOWNLOAD_TIMEOUT_MS,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'image/*',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return { buffer: Buffer.from(imageResponse.data) };
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      // Mirror the error typing used elsewhere for consistency
      if (status === 403) {
        throw new Error(
          'ACCESS_DENIED: Unable to fetch raster from provided URL (HTTP 403). It may be restricted or expired.'
        );
      }
      throw new Error(
        `FETCH_FAILED: Unable to fetch raster (HTTP ${status}): ${data?.message || 'Unknown error'}`
      );
    }
    throw new Error(`FETCH_FAILED: ${error.message}`);
  }
}


/**
 * Detect if content is illustration or icon based on URL and metadata
 */
function detectCategory(url, metadata = {}) {
  const urlLower = url.toLowerCase();
  
  if (urlLower.includes('/icon') || urlLower.includes('/icons')) return 'icons';
  if (urlLower.includes('/illustration') || urlLower.includes('/vector')) return 'illustrations';
  
  if (metadata.width && metadata.height) {
    const aspectRatio = metadata.width / metadata.height;
    if (Math.abs(aspectRatio - 1) < 0.1 && metadata.width <= 512) {
      return 'icons';
    }
  }
  
  return 'illustrations';
}

/**
 * Extract color palette from image buffer
 */
async function extractColorPalette(buffer) {
  try {
    const processedBuffer = await sharp(buffer)
      .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    
    const { data, info } = await sharp(processedBuffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const colorMap = new Map();
    const channels = info.channels;
    
    for (let i = 0; i < data.length; i += channels) {
      const r = Math.round(data[i] / 32) * 32;
      const g = Math.round(data[i + 1] / 32) * 32;
      const b = Math.round(data[i + 2] / 32) * 32;
      const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      
      colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
    }
    
    const sortedColors = Array.from(colorMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([color]) => color);
    
    return {
      palette: sortedColors,
      dominant: sortedColors[0] || '#000000'
    };
  } catch (error) {
    console.error('Color extraction failed:', error);
    return { palette: ['#000000'], dominant: '#000000' };
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
    
    let sum = 0, min = 255, max = 0;
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    
    const brightness = (sum / data.length) / 255;
    const contrast = (max - min) / 255;
    
    let edges = 0;
    const threshold = 30;
    for (let y = 1; y < info.height - 1; y++) {
      for (let x = 1; x < info.width - 1; x++) {
        const idx = y * info.width + x;
        const dx = Math.abs(data[idx] - data[idx + 1]);
        const dy = Math.abs(data[idx] - data[idx + info.width]);
        if (dx > threshold || dy > threshold) edges++;
      }
    }
    
    const edgeDensity = edges / (info.width * info.height);
    
    let vectorComplexity = 'low';
    if (edgeDensity > 0.15) vectorComplexity = 'high';
    else if (edgeDensity > 0.08) vectorComplexity = 'moderate';
    
    return {
      brightness, contrast, edge_density: edgeDensity,
      vector_complexity_hint: vectorComplexity,
      dimensions: { width: info.width, height: info.height }
    };
  } catch (error) {
    console.error('Stats calculation failed:', error);
    return {
      brightness: 0.5, contrast: 0.5, edge_density: 0.1,
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
    const processed = await sharp(buffer)
      .resize(32, 32, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    
    let sum = 0;
    for (let i = 0; i < processed.length; i++) sum += processed[i];
    const mean = sum / processed.length;
    
    let hash = '';
    for (let i = 0; i < processed.length; i += 4) {
      hash += processed[i] > mean ? '1' : '0';
    }
    
    let hexHash = '';
    for (let i = 0; i < hash.length; i += 8) {
      hexHash += parseInt(hash.substr(i, 8), 2).toString(16).padStart(2, '0');
    }
    
    return hexHash;
  } catch (error) {
    console.error('PHash generation failed:', error);
    return crypto.randomBytes(32).toString('hex');
  }
}

/**
 * Extract all style features from a single image
 */
async function extractFeaturesFromBuffer(buffer, url) {
  const cached = featureCache.get(url);
  if (cached) {
    console.log(`Using cached features for ${url}`);
    return cached;
  }
  
  const [colorData, stats, phash, metadata] = await Promise.all([
    extractColorPalette(buffer),
    calculateImageStats(buffer),
    generatePHash(buffer),
    sharp(buffer).metadata()
  ]);
  
  const features = {
    source_url: url,
    category: detectCategory(url, metadata),
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
      if (!validateFreepikUrl(url)) throw new Error('Invalid Freepik URL');
      console.log(`Processing ${i + 1}/${urls.length}: ${url}`);
      const buffer = await downloadToMemory(url);
      const features = await extractFeaturesFromBuffer(buffer, url);
      results.push(features);
      if (i < urls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_DELAY_MS));
      }
    } catch (error) {
      console.log(`[Inspiration] Error processing ${url}: ${error.message}`);
      
      // Check if it's a premium content restriction
      if (error.message.includes('PREMIUM_CONTENT_RESTRICTION')) {
        errors.push({ 
          url: url, 
          error: error.message,
          type: 'premium_restriction',
          suggestions: generateFreeAlternativeSuggestions(url)
        });
      } else {
        errors.push({ url: url, error: error.message, type: 'general_error' });
      }
    }
  }
  
  return { results, errors };
}

/**
 * Generate suggestions for free alternatives when premium content is restricted
 */
function generateFreeAlternativeSuggestions(restrictedUrl) {
  try {
    const url = new URL(restrictedUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // Extract potential keywords from URL
    const keywords = [];
    pathParts.forEach(part => {
      if (part.includes('-')) {
        keywords.push(...part.split('-').filter(word => word.length > 2));
      }
    });
    
    // Generate simpler search terms
    const freeSearchTerms = [
      'free vector icons',
      'simple illustration',
      'basic vector',
      'outline icons',
      'minimalist design'
    ];
    
    // If we can extract meaningful keywords, add them
    if (keywords.length > 0) {
      const mainKeyword = keywords[0];
      freeSearchTerms.unshift(
        `free ${mainKeyword} icon`,
        `simple ${mainKeyword} vector`,
        `${mainKeyword} outline`
      );
    }
    
    return {
      search_terms: freeSearchTerms.slice(0, 5),
      tips: [
        'Search for "free" + your keyword in Freepik',
        'Try simpler, outline-style versions',
        'Look for basic geometric designs',
        'Use icons instead of complex illustrations'
      ]
    };
  } catch (e) {
    return {
      search_terms: ['free vector icons', 'simple illustration', 'basic design'],
      tips: ['Try searching for free alternatives in Freepik']
    };
  }
}

/**
 * Generate style recipe based on extracted features
 */
function generateStyleRecipe(features) {
  if (!features || features.length === 0) {
    throw new Error('No features to generate recipe from');
  }
  
  const isMainlyIcons = features.filter(f => f.category === 'icons').length > features.length / 2;
  const avgBrightness = features.reduce((s, f) => s + f.brightness, 0) / features.length;
  const avgEdgeDensity = features.reduce((s, f) => s + f.edge_density, 0) / features.length;
  
  const allColors = features.flatMap(f => f.palette);
  const colorFrequency = allColors.reduce((acc, color) => {
    acc[color] = (acc[color] || 0) + 1;
    return acc;
  }, {});
  const commonColors = Object.entries(colorFrequency).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([color]) => color);
  
  let stylePrompt = isMainlyIcons ? 'Clean, minimalist icon design' :
    avgBrightness > 0.7 ? 'Bright, vibrant illustration' :
    avgBrightness < 0.3 ? 'Dark, moody illustration' : 'Balanced illustration';
  
  stylePrompt += avgEdgeDensity > 0.15 ? ' with intricate details' :
    avgEdgeDensity < 0.05 ? ' with simple shapes' : ' with moderate detail';

  return {
    style_prompt: stylePrompt,
    recraft_profile: isMainlyIcons ? 'minimal' : 'default',
    svg_constraints: { max_colors: isMainlyIcons ? 4 : 8, merge_paths: isMainlyIcons },
    derived_from: {
      urls: features.map(f => f.source_url),
      dominant_colors: commonColors.slice(0, 3),
      main_category: isMainlyIcons ? 'icons' : 'illustrations'
    }
  };
}

/**
 * Check similarity between generated output and inspiration sources
 */
async function checkSimilarity(outputBuffer, inspirationUrls = []) {
  const outputHash = await generatePHash(outputBuffer);
  const similarities = [];
  
  for (const url of inspirationUrls) {
    const features = featureCache.get(url);
    if (features?.phash) {
      const similarity = featureCache.calculatePHashSimilarity(outputHash, features.phash);
      if (similarity >= CONFIG.SIMILARITY_THRESHOLD) {
        similarities.push({ source_url: url, similarity, threshold: CONFIG.SIMILARITY_THRESHOLD });
      }
    }
  }
  
  return {
    is_too_similar: similarities.length > 0,
    similarities,
    output_phash: outputHash,
  };
}

/**
 * Apply style adjustments to reduce similarity
 */
function generateAdjustmentStrategy(similarities) {
    const strategies = [];
    if (similarities.length > 0) {
        const maxSimilarity = Math.max(...similarities.map(s => s.similarity));
        if (maxSimilarity > 0.95) {
            strategies.push({ action: 'color_shift', params: { hue_rotate: 60 } });
            strategies.push({ action: 'merge_paths', params: { aggressive: true } });
        } else {
            strategies.push({ action: 'color_variation' });
            strategies.push({ action: 'simplify', params: { reduction: 0.1 } });
        }
    }
    return strategies;
}

// =============== EXPRESS ROUTE HANDLERS ===============

async function extractInspiration(req, res) {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Invalid request', message: 'Please provide an array of Freepik URLs' });
    }
    const { results, errors } = await processUrls(urls);
    const validResults = results.filter(r => r.category === 'illustrations' || r.category === 'icons');
    
    if (validResults.length === 0 && errors.length > 0) {
      return res.status(400).json({ error: 'Could not extract features from provided URLs', message: errors[0].error, details: errors });
    }
    
    res.json({ success: true, features: validResults, errors });
  } catch (error) {
    res.status(500).json({ error: 'Processing failed', message: error.message });
  }
}

async function generateRecipe(req, res) {
  try {
    const { urls } = req.body;
     if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Invalid request', message: 'Please provide an array of Freepik URLs' });
    }
    const { results, errors } = await processUrls(urls);
    const validResults = results.filter(r => r.category === 'illustrations' || r.category === 'icons');
    
    if (validResults.length === 0) {
      const errorMessage = errors.length > 0 ? errors[0].error : 'Could not extract features from any of the provided URLs.';
      return res.status(400).json({ error: 'No valid content', message: errorMessage, errors: errors });
    }
    
    const recipe = generateStyleRecipe(validResults);
    res.json({ success: true, recipe, features_extracted: validResults.length, errors });
  } catch (error) {
    res.status(500).json({ error: 'Recipe generation failed', message: error.message });
  }
}

async function checkOutputSimilarity(req, res) {
  try {
    const { output_url, inspiration_urls } = req.body;
    if (!output_url) return res.status(400).json({ error: 'Invalid request', message: 'Please provide output_url' });
  // output_url may not be a Freepik page; fetch directly as raster
  const { buffer: outputBuffer } = await loadRasterFromUrl(output_url);
    const similarityResult = await checkSimilarity(outputBuffer, inspiration_urls || []);
    const adjustments = generateAdjustmentStrategy(similarityResult.similarities);
    
    res.json({
      ...similarityResult,
      adjustments,
      recommendation: similarityResult.is_too_similar ? 'Apply adjustments and regenerate' : 'Output is sufficiently unique'
    });
  } catch (error) {
    res.status(500).json({ error: 'Similarity check failed', message: error.message });
  }
}

function getCacheInfo(req, res) {
  res.json({
    size: featureCache.cache.size,
    max_size: featureCache.maxSize,
    items: Array.from(featureCache.cache.entries()).map(([url, features]) => ({
      url, category: features.category, cached_at: features.cached_at,
      phash: features.phash.substring(0, 8) + '...'
    }))
  });
}

function clearCache(req, res) {
  const previousSize = featureCache.cache.size;
  featureCache.cache.clear();
  res.json({ success: true, message: 'Cache cleared', items_cleared: previousSize });
}

module.exports = {
  extractInspiration,
  generateRecipe,
  checkOutputSimilarity,
  getCacheInfo,
  clearCache,
  _internal: {
    validateFreepikUrl,
    detectCategory,
    extractFeaturesFromBuffer,
    generateStyleRecipe,
    checkSimilarity,
    featureCache,
    processUrls,
  generateAdjustmentStrategy,
  loadRasterFromUrl,
  downloadToMemory
  }
};
