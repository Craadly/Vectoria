// services/inspirationService.js
'use strict';

/**
 * Freepik Inspiration Service
 * Extracts lightweight style features from Freepik illustrations/icons
 * for AI pipeline guidance. Uses the official Freepik API for downloading,
 * and robustly handles ZIP/HTML/SVG by resolving to a raster preview first.
 */

const axios = require('axios');
const sharp = require('sharp');
const crypto = require('crypto');
const { URL } = require('url');
const unzipper = require('unzipper');
const { fileTypeFromBuffer } = require('file-type');
const config = require('../config/env');

// ======================================
// Configuration
// ======================================
const CONFIG = {
    SIMILARITY_THRESHOLD: parseFloat(process.env.SIMILARITY_THRESHOLD || '0.92'),
    DOWNLOAD_TIMEOUT_MS: 15000,
    MAX_IMAGE_SIZE_MB: 10,
    ALLOWED_DOMAINS: ['freepik.com', 'www.freepik.com', 'img.freepik.com'],
    USER_AGENT: 'Vectoria/1.0 (+https://vectoria.ai; Style-Analysis)',
    RATE_LIMIT_DELAY_MS: 500, // Delay between requests to respect rate limits
};

// ======================================
// Small utils
// ======================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * In-memory feature cache (LRU-style)
 */
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
            cached_at: new Date().toISOString(),
        });
    }

    get(key) {
        const value = this.cache.get(key);
        if (value) {
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

// ======================================
// URL & ID helpers
// ======================================
function validateFreepikUrl(urlString) {
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        return CONFIG.ALLOWED_DOMAINS.some(
            (domain) => hostname === domain || hostname.endsWith('.' + domain)
        );
    } catch {
        return false;
    }
}

/**
 * Extract Freepik resource ID from a typical asset page URL:
 * e.g. /free-vector/pink-gradient-social-media-logo_5516204.htm
 */
function extractResourceIdFromUrl(urlString) {
    try {
        const url = new URL(urlString);
        const match = url.pathname.match(/_(\d+)\.htm/i);
        if (match && match[1]) return match[1];
        return null;
    } catch {
        return null;
    }
}

// ======================================
// Robust content loader
// - Resolves any URL to a raster buffer supported by sharp()
// - Handles ZIP packages (extracts preview.*), HTML (follows og:image), SVG
// ======================================
async function loadRasterFromUrl(url, extraHeaders = {}) {
    const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: {
            'User-Agent': CONFIG.USER_AGENT,
            Accept: 'image/*,application/zip;q=0.9,*/*;q=0.8',
            ...extraHeaders,
        },
        timeout: CONFIG.DOWNLOAD_TIMEOUT_MS,
        maxRedirects: 5,
        maxContentLength: CONFIG.MAX_IMAGE_SIZE_MB * 1024 * 1024,
        validateStatus: (s) => s >= 200 && s < 400,
    });

    const buf = Buffer.from(resp.data);
    const headerCt = String(resp.headers['content-type'] || '').split(';')[0].toLowerCase();

    let type = await fileTypeFromBuffer(buf);
    if (!type && headerCt) {
        // Fall back to server-provided content-type when magic-bytes are ambiguous (e.g., SVG)
        type = { mime: headerCt, ext: headerCt.split('/')[1] || '' };
    }

    console.log('[Inspiration] Fetched content-type:', headerCt || type?.mime || 'unknown', 'length:', buf.length);

    const supported = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/avif',
        'image/gif',
        'image/svg+xml',
    ]);

    // Directly supported by sharp (SVG depends on environment; we still pass it through)
    if (supported.has(type?.mime)) {
        return { buffer: buf, mime: type.mime, ext: type.ext };
    }

    // If this is a ZIP package, extract a preview raster
    if (headerCt === 'application/zip' || type?.mime === 'application/zip' || /\.zip(\?|$)/i.test(url)) {
        const out = await extractPreviewFromZip(buf);
        if (out) return out;
        throw new Error('ZIP did not contain a raster preview image');
    }

    // If HTML page, try to follow og:image
    if ((headerCt || '').includes('text/html')) {
        const html = buf.toString('utf8');
        const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
        if (m && m[1]) {
            console.log('[Inspiration] Resolved og:image:', m[1]);
            return loadRasterFromUrl(m[1], extraHeaders);
        }
        throw new Error('Received HTML instead of an image; cannot extract preview.');
    }

    throw new Error(`Unsupported content-type: ${headerCt || type?.mime || 'unknown'}`);
}

/**
 * Extract a preview raster from a Freepik ZIP buffer.
 * Prefers preview.jpg/png; otherwise chooses the largest raster.
 */
async function extractPreviewFromZip(zipBuffer) {
    const directory = await unzipper.Open.buffer(zipBuffer);

    const preferred = new Set(['preview.jpg', 'preview.png', 'images/preview.jpg', 'images/preview.png']);

    const files = directory.files.filter((f) => !f.path.endsWith('/'));

    let entry =
        files.find((f) => preferred.has(f.path.toLowerCase())) ||
        files
            .filter((f) => /\.(jpe?g|png|webp|avif)$/i.test(f.path))
            .sort((a, b) => (b.uncompressedSize || 0) - (a.uncompressedSize || 0))[0];

    if (!entry) return null;

    const content = await entry.buffer();
    const type = await fileTypeFromBuffer(content);
    return { buffer: content, mime: type?.mime || 'image/jpeg', ext: type?.ext || 'jpg' };
}

// ======================================
// Download helpers
// ======================================

/**
 * General-purpose downloader: resolves URL into a sharp-readable raster buffer.
 * - If the URL is a Freepik page URL, use the Freepik API flow automatically.
 * - Otherwise, try to load raster directly (handles HTML/ZIP/og:image).
 */
async function downloadToMemory(url) {
    try {
        // If it's a Freepik page, use the API to get a temporary download URL first
        if (validateFreepikUrl(url) && /\/(free-vector|free-icon|vector|icon)\//i.test(url)) {
            const resourceId = extractResourceIdFromUrl(url);
            if (!resourceId) {
                throw new Error(`Could not extract a resource ID from the URL: ${url}`);
            }

            const apiKey = config.FREEPIK_API_KEY;
            if (!apiKey) {
                throw new Error('FREEPIK_API_KEY is missing. Please set it in your environment.');
            }

            console.log(`[Inspiration] Requesting download URL for resource ${resourceId}`);
            const apiResponse = await axios.get(`https://api.freepik.com/v1/resources/${resourceId}/download`, {
                headers: { 'x-freepik-api-key': apiKey, Accept: 'application/json' },
                timeout: CONFIG.DOWNLOAD_TIMEOUT_MS,
                validateStatus: (s) => s >= 200 && s < 400,
            });

            const downloadUrl = apiResponse?.data?.data?.url;
            if (!downloadUrl) {
                const apiError = apiResponse?.data?.error?.message || 'Unknown Freepik API error';
                throw new Error(`Could not get a download URL from Freepik API. ${apiError}`);
            }

            console.log('[Inspiration] Downloading image from temporary URL...');
            const { buffer } = await loadRasterFromUrl(downloadUrl);
            // Early validation: ensure sharp can parse it (will throw if unsupported)
            await sharp(buffer).metadata();
            return buffer;
        }

        // Fallback/generic path: load whatever the URL points to (PNG/JPG/ZIP/HTML)
        const { buffer } = await loadRasterFromUrl(url);
        await sharp(buffer).metadata();
        return buffer;
    } catch (error) {
        // Attach better diagnostics
        if (axios.isAxiosError(error) && error.response) {
            const { status, headers, data } = error.response || {};
            console.error('Download error (HTTP):', status, headers && headers['content-type']);
            throw new Error(
                `Download failed (HTTP ${status || '???'}): ${(data && (data.error?.message || data.message)) || error.message
                }`
            );
        }
        console.error(`[Inspiration] Failed to download ${url}:`, error.message);
        throw error;
    }
}

// ======================================
// Category detection
// ======================================
function detectCategory(url, metadata = {}) {
    const urlLower = (url || '').toLowerCase();

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

// ======================================
// Feature extractors
// ======================================
async function extractColorPalette(buffer) {
    try {
        const processedBuffer = await sharp(buffer).resize(200, 200, { fit: 'inside', withoutEnlargement: true }).toBuffer();

        const { data, info } = await sharp(processedBuffer).raw().toBuffer({ resolveWithObject: true });

        const colorMap = new Map();
        const channels = info.channels;

        for (let i = 0; i < data.length; i += channels) {
            const r = Math.round(data[i] / 32) * 32;
            const g = Math.round(data[i + 1] / 32) * 32;
            const b = Math.round(data[i + 2] / 32) * 32;
            const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
                .toString(16)
                .padStart(2, '0')}`;

            colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
        }

        const sortedColors = Array.from(colorMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([color]) => color);

        return {
            palette: sortedColors,
            dominant: sortedColors[0] || '#000000',
        };
    } catch (error) {
        console.error('Color extraction failed:', error);
        return { palette: ['#000000'], dominant: '#000000' };
    }
}

async function calculateImageStats(buffer) {
    try {
        const { data, info } = await sharp(buffer)
            .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true });

        let sum = 0,
            min = 255,
            max = 0;
        for (let i = 0; i < data.length; i++) {
            const value = data[i];
            sum += value;
            if (value < min) min = value;
            if (value > max) max = value;
        }

        const brightness = sum / data.length / 255;
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
            brightness,
            contrast,
            edge_density: edgeDensity,
            vector_complexity_hint: vectorComplexity,
            dimensions: { width: info.width, height: info.height },
        };
    } catch (error) {
        console.error('Stats calculation failed:', error);
        return {
            brightness: 0.5,
            contrast: 0.5,
            edge_density: 0.1,
            vector_complexity_hint: 'moderate',
            dimensions: { width: 0, height: 0 },
        };
    }
}

async function generatePHash(buffer) {
    try {
        const processed = await sharp(buffer).resize(32, 32, { fit: 'fill' }).greyscale().raw().toBuffer();

        let sum = 0;
        for (let i = 0; i < processed.length; i++) sum += processed[i];
        const mean = sum / processed.length;

        let bitString = '';
        for (let i = 0; i < processed.length; i += 4) {
            bitString += processed[i] > mean ? '1' : '0';
        }

        let hexHash = '';
        for (let i = 0; i < bitString.length; i += 8) {
            const byte = bitString.slice(i, i + 8);
            hexHash += parseInt(byte, 2).toString(16).padStart(2, '0');
        }

        return hexHash;
    } catch (error) {
        console.error('PHash generation failed:', error);
        return crypto.randomBytes(32).toString('hex');
    }
}

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
        sharp(buffer).metadata(),
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
        dimensions: stats.dimensions,
    };

    featureCache.set(url, features);
    return features;
}

// ======================================
// Batch processing
// ======================================
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
            if (i < urls.length - 1) await sleep(CONFIG.RATE_LIMIT_DELAY_MS);
        } catch (error) {
            console.error('[Inspiration] Error for URL:', url, error.message);
            errors.push({ url, error: error.message });
        }
    }

    return { results, errors };
}

// ======================================
// Recipe generation & similarity
// ======================================
function generateStyleRecipe(features) {
    if (!features || features.length === 0) {
        throw new Error('No features to generate recipe from');
    }

    const isMainlyIcons = features.filter((f) => f.category === 'icons').length > features.length / 2;
    const avgBrightness = features.reduce((s, f) => s + f.brightness, 0) / features.length;
    const avgEdgeDensity = features.reduce((s, f) => s + f.edge_density, 0) / features.length;

    const allColors = features.flatMap((f) => f.palette);
    const colorFrequency = allColors.reduce((acc, color) => {
        acc[color] = (acc[color] || 0) + 1;
        return acc;
    }, {});
    const commonColors = Object.entries(colorFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([color]) => color);

    let stylePrompt = isMainlyIcons ? 'Clean, minimalist icon design' : 'Balanced illustration';
    if (!isMainlyIcons) {
        if (avgBrightness > 0.7) stylePrompt = 'Bright, vibrant illustration';
        else if (avgBrightness < 0.3) stylePrompt = 'Dark, moody illustration';
    }

    stylePrompt +=
        avgEdgeDensity > 0.15 ? ' with intricate details' : avgEdgeDensity < 0.05 ? ' with simple shapes' : ' with moderate detail';

    return {
        style_prompt: stylePrompt,
        recraft_profile: isMainlyIcons ? 'minimal' : 'default',
        svg_constraints: { max_colors: isMainlyIcons ? 4 : 8, merge_paths: isMainlyIcons },
        derived_from: {
            urls: features.map((f) => f.source_url),
            dominant_colors: commonColors.slice(0, 3),
            main_category: isMainlyIcons ? 'icons' : 'illustrations',
        },
    };
}

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

function generateAdjustmentStrategy(similarities) {
    const strategies = [];
    if (similarities.length > 0) {
        const maxSimilarity = Math.max(...similarities.map((s) => s.similarity));
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

// ======================================
// Express Route Handlers
// ======================================
async function extractInspiration(req, res) {
    try {
        const { urls } = req.body;
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: 'Invalid request', message: 'Please provide an array of Freepik URLs' });
        }
        const { results, errors } = await processUrls(urls);
        const validResults = results.filter((r) => r.category === 'illustrations' || r.category === 'icons');

        if (validResults.length === 0 && errors.length > 0) {
            return res
                .status(400)
                .json({ error: 'Could not extract features from provided URLs', message: errors[0].error, details: errors });
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
        const validResults = results.filter((r) => r.category === 'illustrations' || r.category === 'icons');

        if (validResults.length === 0) {
            const errorMessage = errors.length > 0 ? errors[0].error : 'Could not extract features from any of the provided URLs.';
            return res.status(400).json({ error: 'No valid content', message: errorMessage, errors });
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

        // The output_url may be your own CDN/S3; use generic loader (handles PNG/JPG/SVG)
        const outputBuffer = await downloadToMemory(output_url);
        const similarityResult = await checkSimilarity(outputBuffer, inspiration_urls || []);
        const adjustments = generateAdjustmentStrategy(similarityResult.similarities);

        res.json({
            ...similarityResult,
            adjustments,
            recommendation: similarityResult.is_too_similar ? 'Apply adjustments and regenerate' : 'Output is sufficiently unique',
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
            url,
            category: features.category,
            cached_at: features.cached_at,
            phash: (features.phash || '').substring(0, 8) + '...',
        })),
    });
}

function clearCache(req, res) {
    const previousSize = featureCache.cache.size;
    featureCache.cache.clear();
    res.json({ success: true, message: 'Cache cleared', items_cleared: previousSize });
}

// ======================================
// Exports
// ======================================
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
        // for tests/debugging:
        extractPreviewFromZip,
        loadRasterFromUrl,
        downloadToMemory,
    },
};

