// services/pipelineService.js
'use strict';

/**
 * Pipeline Orchestrator:
 *  - Freepik search (2-3 refs)
 *  - Analyze refs -> palettes & style hints
 *  - Build enhanced prompt (user prompt + derived style)
 *  - Generate image with Gemini image-generation
 *  - Recraft removeBackground -> vectorize (SVG)
 *
 * Requires:
 *   - FREEPIK_API_KEY
 *   - GEMINI_API_KEY
 *   - RECRAFT_API_KEY
 *   - (Optionally) GOOGLE_PROJECT_ID / LOCATION only if you also call Imagen elsewhere
 */

const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const { fileTypeFromBuffer } = require('file-type');

const config = require('../config/env');
const {
  _internal: {
    loadRasterFromUrl, // from services/inspirationService.js
    downloadToMemory,
    extractPreviewFromZip, // (not used directly here, but handy)
    extractFeaturesFromBuffer, // palette, brightness, edge-hints, etc.
  },
} = require('./inspirationService');

// -------------------- Freepik --------------------

/**
 * Search Freepik (stock content API)
 * Docs: GET https://api.freepik.com/v1/resources?term=...&limit=...&order=relevance
 * Ref: docs.freepik.com (resources search) :contentReference[oaicite:0]{index=0}
 */
async function freepikSearch(term, limit = 3) {
  const { FREEPIK_API_KEY } = config;
  if (!FREEPIK_API_KEY) {
    throw new Error('FREEPIK_API_KEY is missing.');
  }

  const url = 'https://api.freepik.com/v1/resources';
  const res = await axios.get(url, {
    headers: { 'x-freepik-api-key': FREEPIK_API_KEY, 'Accept-Language': 'en-US' },
    params: {
      term,
      limit: Math.max(1, Math.min(limit, 5)),
      order: 'relevance',
      // You can add filters later if needed (e.g., vectors only)
    },
    timeout: 15000,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const items = (res.data?.data || []).map((d) => ({
    id: d.id,
    title: d.title,
    page_url: d.url, // e.g. https://www.freepik.com/free-vector/..._ID.htm
    thumb: d.image?.source?.url || null,
    type: d.image?.type || null, // 'vector' | 'photo' | ...
  }));

  return items.slice(0, limit);
}

/**
 * Use Freepik API to get a temporary download URL for a resource id.
 * Docs: GET /v1/resources/{resource-id}/download :contentReference[oaicite:1]{index=1}
 */
async function freepikGetDownloadUrl(resourceId) {
  const { FREEPIK_API_KEY } = config;
  const url = `https://api.freepik.com/v1/resources/${resourceId}/download`;
  const res = await axios.get(url, {
    headers: { 'x-freepik-api-key': FREEPIK_API_KEY, Accept: 'application/json' },
    timeout: 15000,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const downloadUrl = res?.data?.data?.url;
  if (!downloadUrl) throw new Error('Freepik: missing download URL.');
  return downloadUrl;
}

// -------------------- Prompt building --------------------

/**
 * Build an enhanced prompt using base user prompt + style features from refs.
 * We derive a small, stable palette and style hints (icon vs illustration, complexity, brightness).
 */
function buildEnhancedPrompt(basePrompt, featureList) {
  // Aggregate top colors
  const allColors = featureList.flatMap((f) => f.palette || []);
  const colorFrequency = allColors.reduce((acc, c) => ((acc[c] = (acc[c] || 0) + 1), acc), {});
  const commonColors = Object.entries(colorFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([c]) => c);

  // Category balance & complexity
  const iconCount = featureList.filter((f) => f.category === 'icons').length;
  const mostlyIcons = iconCount > featureList.length / 2;
  const avgBrightness = featureList.reduce((s, f) => s + (f.brightness ?? 0.5), 0) / featureList.length;
  const avgEdge = featureList.reduce((s, f) => s + (f.edge_density ?? 0.1), 0) / featureList.length;

  let style = mostlyIcons ? 'clean vector icon set' : 'modern flat vector illustration';
  if (!mostlyIcons) {
    if (avgBrightness > 0.7) style = 'bright, vibrant vector illustration';
    else if (avgBrightness < 0.3) style = 'dark, moody vector illustration';
  }
  style +=
    avgEdge > 0.15 ? ', intricate detail' : avgEdge < 0.05 ? ', simple geometric shapes' : ', moderate detail';

  const paletteHint =
    commonColors.length > 0
      ? `Use a cohesive color palette emphasizing ${commonColors.slice(0, 3).join(', ')}.`
      : 'Use a cohesive limited color palette.';

  // Enhancement extras (safe defaults you can tweak)
  const enhancement = [
    'Clean SVG-ready shapes',
    'crisp edges',
    'no noise',
    'coherent lighting',
    'consistent perspective',
    'solid fills with subtle gradients only where needed',
    'avoid tiny unreadable details',
  ].join(', ');

  return [
    basePrompt,
    `Style: ${style}.`,
    paletteHint,
    `Enhancements: ${enhancement}.`,
    'Output should be well-suited for clean background removal and vectorization.',
  ].join('\n');
}

// -------------------- Gemini (image generation) --------------------
// Docs (REST): ai.google.dev — gemini-2.0-flash-preview-image-generation:generateContent
// Requires responseModalities ["TEXT","IMAGE"] and inlineData for image refs. :contentReference[oaicite:2]{index=2}

async function generateImageWithGemini({ prompt, referenceImages = [] }) {
  const { GEMINI_API_KEY } = config;
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing.');

  // Build contents: text + inlineData images (base64)
  const parts = [{ text: prompt }];
  for (const ref of referenceImages) {
    // best-effort mimetype
    const t = await fileTypeFromBuffer(ref).catch(() => null);
    parts.push({
      inline_data: {
        mime_type: t?.mime || 'image/png',
        data: ref.toString('base64'),
      },
    });
  }

  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent';

  const res = await axios.post(
    endpoint,
    {
      contents: [{ parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    {
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
      validateStatus: (s) => s >= 200 && s < 400,
    }
  );

  // Find the first inline image in candidates
  const candidates = res.data?.candidates || [];
  for (const c of candidates) {
    const partsOut = c?.content?.parts || [];
    for (const p of partsOut) {
      if (p?.inline_data?.data) {
        const mime = p.inline_data?.mime_type || 'image/png';
        const buf = Buffer.from(p.inline_data.data, 'base64');
        return { buffer: buf, mime };
      }
    }
  }

  // If we reach here, we have only text or nothing
  const text = candidates[0]?.content?.parts?.find((p) => p.text)?.text;
  throw new Error(`Gemini returned no image. Text output: ${text || '(none)'}`);
}

// -------------------- Recraft (bg removal & vectorize) --------------------
// Docs: https://external.api.recraft.ai/v1
// - POST /images/removeBackground (multipart/form-data) :contentReference[oaicite:3]{index=3}
// - POST /images/vectorize (multipart/form-data) :contentReference[oaicite:4]{index=4}

async function recraftRemoveBg(imageBuffer, mime = 'image/png') {
  const { RECRAFT_API_KEY } = config;
  if (!RECRAFT_API_KEY) throw new Error('RECRAFT_API_KEY is missing.');
  const fd = new FormData();
  fd.append('file', imageBuffer, { filename: 'input.' + (mime.split('/')[1] || 'png'), contentType: mime });

  const res = await axios.post('https://external.api.recraft.ai/v1/images/removeBackground', fd, {
    headers: { Authorization: `Bearer ${RECRAFT_API_KEY}`, ...fd.getHeaders() },
    timeout: 90000,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  // Response contains { image: { url } }
  const url = res.data?.image?.url || res.data?.data?.[0]?.url;
  if (!url) throw new Error('Recraft removeBackground: missing URL in response.');
  // Download the processed PNG
  const out = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(out.data);
}

async function recraftVectorize(imageBuffer, mime = 'image/png') {
  const { RECRAFT_API_KEY } = config;
  const fd = new FormData();
  fd.append('file', imageBuffer, { filename: 'input.' + (mime.split('/')[1] || 'png'), contentType: mime });

  const res = await axios.post('https://external.api.recraft.ai/v1/images/vectorize', fd, {
    headers: { Authorization: `Bearer ${RECRAFT_API_KEY}`, ...fd.getHeaders() },
    timeout: 120000,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  // Response contains { image: { url } } (SVG)
  const url = res.data?.image?.url || res.data?.data?.[0]?.url;
  if (!url) throw new Error('Recraft vectorize: missing URL in response.');
  return url; // directly return hosted SVG URL
}

// -------------------- Helpers --------------------

/**
 * Ensure the buffer <= 5MB and <= 4096px max dimension (Recraft limits).
 * If oversized, downscale + recompress to PNG or WEBP.
 */
async function ensureRecraftLimits(buffer, targetMime = 'image/png') {
  if (buffer.length <= 4.9 * 1024 * 1024) return { buffer, mime: targetMime };

  // Downscale with sharp to ~2048 max side, then compress
  const s = sharp(buffer);
  const meta = await s.metadata();
  const max = Math.max(meta.width || 0, meta.height || 0);
  const factor = max > 2048 ? 2048 / max : 1;

  let out = s;
  if (factor < 1) out = out.resize(Math.round((meta.width || 0) * factor), Math.round((meta.height || 0) * factor));

  if (targetMime === 'image/webp') {
    const buf = await out.webp({ quality: 92 }).toBuffer();
    if (buf.length <= 4.9 * 1024 * 1024) return { buffer: buf, mime: 'image/webp' };
    return { buffer: await sharp(buf).webp({ quality: 85 }).toBuffer(), mime: 'image/webp' };
  } else {
    const buf = await out.png({ compressionLevel: 9 }).toBuffer();
    if (buf.length <= 4.9 * 1024 * 1024) return { buffer: buf, mime: 'image/png' };
    return { buffer: await sharp(buf).png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' };
  }
}

// -------------------- Orchestrator --------------------

/**
 * Main pipeline:
 *  - term: search term
 *  - n: number of inspirations (2..3)
 *  - userPrompt: your base creative brief
 *
 * Returns: { inspirations, enhanced_prompt, gemini_png_bytes, bg_removed_png_bytes, svg_url }
 */
async function createSvgFromSearch({ term, n = 3, userPrompt }) {
  if (!term || !userPrompt) {
    throw new Error('Both "term" and "userPrompt" are required.');
  }

  // 1) Search Freepik
  const picked = await freepikSearch(term, Math.min(Math.max(n, 2), 3)); // clamp 2..3

  // 2) Resolve to preview buffers + features
  const refBuffers = [];
  const refFeatures = [];
  for (const item of picked) {
    // Use page URL -> API download -> preview raster (via inspirationService helpers)
    const dlUrl = await freepikGetDownloadUrl(item.id);
    const { buffer } = await loadRasterFromUrl(dlUrl);
    await sharp(buffer).metadata(); // sanity
    refBuffers.push(buffer);

    const feats = await extractFeaturesFromBuffer(buffer, item.page_url);
    refFeatures.push(feats);
  }

  // 3) Build enhanced prompt
  const enhanced = buildEnhancedPrompt(userPrompt, refFeatures);

  // 4) Generate with Gemini (feed refs as inline images)
  const { buffer: genBuffer, mime: genMime } = await generateImageWithGemini({
    prompt: enhanced,
    referenceImages: refBuffers,
  });

  // 5) Recraft: remove background
  const { buffer: limitedBeforeBG, mime: limitedMimeA } = await ensureRecraftLimits(genBuffer, genMime || 'image/png');
  const bgRemovedPng = await recraftRemoveBg(limitedBeforeBG, limitedMimeA);

  // 6) Recraft: vectorize to SVG
  const { buffer: limitedBeforeSVG, mime: limitedMimeB } = await ensureRecraftLimits(bgRemovedPng, 'image/png');
  const svgUrl = await recraftVectorize(limitedBeforeSVG, limitedMimeB);

  return {
    inspirations: picked.map((p, i) => ({ ...p, palette: refFeatures[i].palette, category: refFeatures[i].category })),
    enhanced_prompt: enhanced,
    gemini_png_bytes: genBuffer.length,
    bg_removed_png_bytes: bgRemovedPng.length,
    svg_url: svgUrl,
  };
}

module.exports = {
  createSvgFromSearch,
  // exposed for testing / future reuse
  _internal: {
    freepikSearch,
    freepikGetDownloadUrl,
    buildEnhancedPrompt,
    generateImageWithGemini,
    recraftRemoveBg,
    recraftVectorize,
    ensureRecraftLimits,
  },
};

