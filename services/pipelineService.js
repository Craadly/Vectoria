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
const { captureScreenshot } = require('./screenshotService');
const imagenService = require('./imagenService');

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
async function freepikSearch(term, limit = 3, { freeOnly = false } = {}) {
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

  let items = (res.data?.data || []).map((d) => ({
    id: d.id,
    title: d.title,
    page_url: d.url, // e.g. https://www.freepik.com/free-vector/..._ID.htm
    thumb: d.image?.source?.url || null,
    type: d.image?.type || null, // 'vector' | 'photo' | ...
  }));

  // Heuristic: prefer Free items when requested. Freepik page URLs commonly include '/free-' for free assets
  if (freeOnly) {
    const freeItems = items.filter((it) => typeof it.page_url === 'string' && /\/free[-_]/.test(it.page_url));
    if (freeItems.length >= Math.min(limit, items.length)) {
      items = freeItems;
    }
    // else: not enough free items found; fall back to mixed list to keep pipeline moving
  }

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
  const mostlyIcons = featureList.length > 0 ? iconCount > featureList.length / 2 : false;
  const avgBrightness = featureList.length > 0
    ? featureList.reduce((s, f) => s + (f.brightness ?? 0.5), 0) / featureList.length
    : 0.5;
  const avgEdge = featureList.length > 0
    ? featureList.reduce((s, f) => s + (f.edge_density ?? 0.1), 0) / featureList.length
    : 0.1;

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

  // Try multiple Gemini endpoints; some may be unavailable (404) depending on API enablement
  const endpoints = [
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent',
  ];

  let res;
  let lastErr;
  for (const endpoint of endpoints) {
    try {
      res = await axios.post(
        endpoint,
        {
          contents: [{ role: 'user', parts }],
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
      break;
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      if (status === 404 || status === 400) continue; // try next
      throw e; // network/401/403 etc: rethrow
    }
  }
  if (!res) {
    const msg = lastErr?.response?.data?.error?.message || lastErr?.message || 'Gemini generateContent failed';
    throw new Error(`GEMINI_UNAVAILABLE: ${msg}`);
  }

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
async function createSvgFromSearch({ term, n = 3, userPrompt, freeOnly = true }) {
  if (!term || !userPrompt) {
    throw new Error('Both "term" and "userPrompt" are required.');
  }

  console.log(`[Pipeline] Starting search for "${term}" with ${n} results, freeOnly=${freeOnly}`);

  // 1) Search Freepik
  const picked = await freepikSearch(term, Math.min(Math.max(n, 2), 3), { freeOnly }); // clamp 2..3
  
  // If Freepik search fails or returns no usable images, use direct AI generation
  if (!picked || picked.length === 0) {
    console.log('[Pipeline] No usable Freepik images found, falling back to direct AI generation');
    // Enhanced prompt without inspirations
    const enhanced = `${userPrompt}. Create a professional, modern design with clean lines and vibrant colors. Style: minimalist, tech-focused, scalable vector graphics.`;
    
    // Try Gemini first, then fall back to Imagen
    let genBuffer, genMime;
    try {
      const gen = await generateImageWithGemini({ prompt: enhanced, referenceImages: [] });
      genBuffer = gen.buffer; genMime = gen.mime;
      console.log('[Pipeline] Generated with Gemini (no inspiration)');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[Pipeline] Gemini unavailable (no refs path), falling back to Imagen: ${e.message}`);
      const imagen = await imagenService.generateImage(enhanced, { analyze: false, skipPostProcessing: false });
      genBuffer = imagen.imageBuffer; genMime = 'image/png';
    }
    const { buffer: limitedBeforeBG, mime: limitedMimeA } = await ensureRecraftLimits(genBuffer, genMime || 'image/png');
    const bgRemovedPng = await recraftRemoveBg(limitedBeforeBG, limitedMimeA);
    const { buffer: limitedBeforeSVG, mime: limitedMimeB } = await ensureRecraftLimits(bgRemovedPng, 'image/png');
    const svgUrl = await recraftVectorize(limitedBeforeSVG, limitedMimeB);
    return {
      inspirations: [],
      enhanced_prompt: enhanced,
      gemini_png_bytes: genBuffer.length,
      bg_removed_png_bytes: bgRemovedPng.length,
      svg_url: svgUrl,
      note: 'Proceeded without inspirations due to no search results.'
    };
  }

  // 2) Resolve to preview buffers + features
  const refBuffers = [];
  const refFeatures = [];
  for (const item of picked) {
    try {
      // Try official API download URL first (may 403 for premium)
      const dlUrl = await freepikGetDownloadUrl(item.id);
      const { buffer } = await loadRasterFromUrl(dlUrl);
      await sharp(buffer).metadata();
      refBuffers.push(buffer);
      const feats = await extractFeaturesFromBuffer(buffer, item.page_url);
      refFeatures.push(feats);
    } catch (err) {
      // Fallback to thumbnail if available; otherwise, try page screenshot; else skip this item
      const msg = (err && err.message) ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[Pipeline] Skipping premium or inaccessible item ${item.id}: ${msg}`);
      if (item.thumb) {
        try {
          const { buffer: thumbBuf } = await loadRasterFromUrl(item.thumb);
          await sharp(thumbBuf).metadata();
          refBuffers.push(thumbBuf);
          const feats = await extractFeaturesFromBuffer(thumbBuf, item.page_url);
          refFeatures.push(feats);
          // eslint-disable-next-line no-console
          console.log(`[Pipeline] Thumbnail fallback used for ${item.id}`);
          continue;
        } catch (e2) {
          // eslint-disable-next-line no-console
          console.warn(`[Pipeline] Thumbnail fallback failed for ${item.id}: ${e2.message}`);
        }
      }
      // Try headless screenshot as last resort (may include watermarks/UI; used only for style cues)
      try {
        const shot = await captureScreenshot(item.page_url, { width: 1024, height: 1024, fullPage: false });
        await sharp(shot).metadata();
        refBuffers.push(shot);
        const feats = await extractFeaturesFromBuffer(shot, item.page_url);
        refFeatures.push(feats);
        // eslint-disable-next-line no-console
        console.log(`[Pipeline] Screenshot fallback used for ${item.id}`);
      } catch (e3) {
        // eslint-disable-next-line no-console
        console.warn(`[Pipeline] Screenshot fallback failed for ${item.id}: ${e3.message}`);
      }
      // no buffer for this item; continue
    }
  }

  // 3) Build enhanced prompt
  const enhanced = buildEnhancedPrompt(userPrompt, refFeatures);

  // 4) Generate with Gemini (feed refs as inline images); fallback to Imagen
  let genBuffer, genMime;
  try {
    const gen = await generateImageWithGemini({
      prompt: enhanced,
      referenceImages: refBuffers.slice(0, 3),
    });
    genBuffer = gen.buffer; genMime = gen.mime;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[Pipeline] Gemini generation failed, falling back to Imagen: ${e.message}`);
    const imagen = await imagenService.generateImage(enhanced, { analyze: false, skipPostProcessing: false });
    genBuffer = imagen.imageBuffer; genMime = 'image/png';
  }

  // 5) Recraft: remove background
  const { buffer: limitedBeforeBG, mime: limitedMimeA } = await ensureRecraftLimits(genBuffer, genMime || 'image/png');
  const bgRemovedPng = await recraftRemoveBg(limitedBeforeBG, limitedMimeA);

  // 6) Recraft: vectorize to SVG
  const { buffer: limitedBeforeSVG, mime: limitedMimeB } = await ensureRecraftLimits(bgRemovedPng, 'image/png');
  const svgUrl = await recraftVectorize(limitedBeforeSVG, limitedMimeB);

  return {
    inspirations: refFeatures.map((feats, i) => ({
      ...(picked[i] || {}),
      palette: feats.palette,
      category: feats.category,
    })),
    enhanced_prompt: enhanced,
    gemini_png_bytes: genBuffer.length,
    bg_removed_png_bytes: bgRemovedPng.length,
    svg_url: svgUrl,
    refs_used: refBuffers.length
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

