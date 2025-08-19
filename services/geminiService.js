// services/geminiService.js
'use strict';

/**
 * Enhanced Gemini service with super intelligence for SVG generation.
 * Features advanced prompt engineering, style understanding, and intelligent fallbacks.
 * NOW WITH DUAL GENERATION MODES: 'vector' for clean icons and 'artistic' for rich illustrations.
 * NEW: The AI now has full creative freedom to choose the color palette.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/env');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// ---- Config validation ------------------------------------------------------
if (!config?.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is missing in config.');
}
if (!config?.GEMINI_MODEL_ID) {
  throw new Error('GEMINI_MODEL_ID is missing in config.');
}
if (!config?.TEMP_DIR) {
  throw new Error('TEMP_DIR is missing in config.');
}

const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// Optional SVGO (auto-used if installed)
let svgoOptimize = null;
try {
  svgoOptimize = require('svgo').optimize;
} catch { /* optional */ }

// ---- Tunables ---------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;
const MAX_PROMPT_WORDS = 200;
const MAX_SVG_BYTES = 500 * 1024;
const DEFAULT_OUTPUT_TOKENS = 300;
const SVG_OUTPUT_TOKENS = 2000;

// ---- Style Intelligence System ----------------------------------------------
const STYLE_PROFILES = {
  minimal: {
    keywords: ['minimalist', 'simple', 'clean', 'basic'],
    attributes: {
      shapes: ['circles', 'rectangles', 'simple polygons'],
      colors: '2-3 solid colors maximum',
      complexity: 'very low',
      details: 'essential elements only'
    }
  },
  geometric: {
    keywords: ['geometric', 'abstract', 'modern', 'angular'],
    attributes: {
      shapes: ['triangles', 'hexagons', 'complex polygons', 'intersecting shapes'],
      colors: '3-5 bold contrasting colors',
      complexity: 'medium',
      details: 'pattern-based, symmetrical'
    }
  },
  organic: {
    keywords: ['natural', 'flowing', 'curved', 'organic'],
    attributes: {
      shapes: ['bezier curves', 'smooth paths', 'ellipses'],
      colors: 'earth tones or nature-inspired palette',
      complexity: 'medium to high',
      details: 'smooth transitions, natural forms'
    }
  },
  playful: {
    keywords: ['fun', 'cartoon', 'playful', 'whimsical', 'mascot', 'character'],
    attributes: {
      shapes: ['rounded rectangles', 'circles', 'blob shapes'],
      colors: 'bright, vibrant',
      complexity: 'medium',
      details: 'friendly, approachable'
    }
  },
  technical: {
    keywords: ['technical', 'blueprint', 'schematic', 'diagram'],
    attributes: {
      shapes: ['precise lines', 'grids', 'technical symbols'],
      colors: 'monochrome or limited technical palette',
      complexity: 'high precision',
      details: 'accurate proportions'
    }
  },
  logo: {
    keywords: ['logo', 'brand', 'identity', 'symbol', 'mark'],
    attributes: {
      shapes: ['memorable forms', 'scalable elements'],
      colors: '1-3 colors, high contrast',
      complexity: 'simple but distinctive',
      details: 'balanced, works at any size'
    }
  }
};

// Enhanced subject understanding
const SUBJECT_ENHANCEMENTS = {
  animals: {
    keywords: ['animal', 'pet', 'creature', 'beast'],
    enhance: (animal) => `stylized ${animal} with characteristic features emphasized`,
    svgTips: 'Use smooth curves for body, geometric shapes for features'
  },
  people: {
    keywords: ['person', 'human', 'character', 'avatar', 'user'],
    enhance: () => 'simplified human figure with distinctive silhouette',
    svgTips: 'Circle for head, rounded rectangles for body parts'
  },
  technology: {
    keywords: ['tech', 'computer', 'device', 'digital', 'cyber', 'ai'],
    enhance: (tech) => `${tech} with clean lines, circuit patterns, or digital motifs`,
    svgTips: 'Use rectangles, straight lines, grid patterns'
  },
  nature: {
    keywords: ['tree', 'plant', 'flower', 'mountain', 'sun', 'cloud'],
    enhance: (nature) => `stylized ${nature} with simplified organic forms`,
    svgTips: 'Use bezier curves for organic shapes, polygons for mountains'
  },
  abstract: {
    keywords: ['abstract', 'concept', 'idea', 'emotion'],
    enhance: (concept) => `abstract representation of ${concept} using shapes and colors`,
    svgTips: 'Combine basic shapes creatively'
  }
};

// ---- Advanced Helper Functions ----------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base * (0.8 + Math.random() * 0.4);

function detectStyle(prompt) {
  const lower = prompt.toLowerCase();
  for (const [style, profile] of Object.entries(STYLE_PROFILES)) {
    if (profile.keywords.some(k => lower.includes(k))) {
      return style;
    }
  }
  if (lower.includes('logo') || lower.includes('brand')) return 'logo';
  if (lower.includes('character') || lower.includes('mascot')) return 'playful';
  return 'geometric';
}

function detectSubject(prompt) {
  const lower = prompt.toLowerCase();
  for (const [category, data] of Object.entries(SUBJECT_ENHANCEMENTS)) {
    if (data.keywords.some(k => lower.includes(k))) {
      return category;
    }
  }
  return 'abstract';
}

function buildIntelligentPrompt(userPrompt, generationMode = 'vector') {
  const style = detectStyle(userPrompt);
  const subject = detectSubject(userPrompt);
  const styleProfile = STYLE_PROFILES[style];
  const subjectData = SUBJECT_ENHANCEMENTS[subject];
  
  const mainConcept = userPrompt.replace(/\b(logo|icon|illustration|design|svg|vector)\b/gi, '').trim();
  
  let enhanced = '';
  
  const isArtisticSubject = ['animals', 'people', 'nature'].includes(subject);
  if (generationMode === 'vector' && isArtisticSubject) {
    enhanced = `Create a bold, geometric brand mark for the concept '${mainConcept}'. The style must be strictly ${style}. Use only these shapes: ${styleProfile.attributes.shapes.join(', ')}. The final output must be a simple, flat, 2D logo suitable for a modern tech company. No artistic elements.`;
  } else {
    let baseEnhancement = mainConcept;
    if (subjectData && subjectData.enhance) {
      baseEnhancement = subjectData.enhance(mainConcept);
    }
    enhanced = `${baseEnhancement}, in a ${style} style, focusing on ${styleProfile.attributes.details}.`;
  }
  
  if (generationMode === 'artistic') {
    enhanced += ` Create a visually rich illustration using a vibrant and professional color palette chosen by the AI. Use subtle gradients for depth. Complex shapes and bezier curves are encouraged for high detail. The composition should be centered on a solid white background.`;
  } else {
    enhanced += ` The design must be a flat vector illustration using a harmonious and modern color palette chosen by the AI. Ensure the composition is perfectly centered with balanced negative space. It must be a scalable design with a solid white background. Absolutely no gradients, no shadows, no textures, and no photorealistic details.`;
  }
  
  return {
    enhanced,
    metadata: { style, subject, styleProfile, subjectData, generationMode }
  };
}


function stripCodeFencesAndQuotes(text) {
  let t = String(text || '').trim();
  t = t.replace(/```(?:svg|xml|html)?\s*([\s\S]*?)```/gi, '$1').trim();
  t = t.replace(/^`+|`+$/g, '').trim();
  t = t.replace(/^"+|"+$/g, '').trim();
  t = t.replace(/^'+|'+$/g, '').trim();
  t = t.replace(/^\s*(enhanced\s*prompt|prompt)\s*:\s*/i, '').trim();
  return t;
}

function clampWords(str, maxWords) {
  const words = String(str || '').trim().split(/\s+/);
  return words.length <= maxWords ? String(str || '').trim() : words.slice(0, maxWords).join(' ');
}

function extractSvgFromText(text) {
  const m = String(text || '').match(/<svg[\s\S]*?<\/svg>/i);
  return m ? m[0] : null;
}

function enhanceSvgCode(svg, metadata) {
  let enhanced = String(svg || '');
  if (!/viewBox\s*=/.test(enhanced)) {
    enhanced = enhanced.replace(/<svg/i, '<svg viewBox="0 0 100 100"');
  }
  if (!/xmlns\s*=/.test(enhanced)) {
    enhanced = enhanced.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/<rect.*width="100".*height="100"/i.test(enhanced)) {
    const bgRect = '<rect width="100" height="100" fill="white"/>';
    enhanced = enhanced.replace(/(<svg[^>]*>)/i, `$1\n  ${bgRect}\n`);
  }
  if (metadata && !/<title>/i.test(enhanced)) {
    const title = `<title>${metadata.style} ${metadata.subject} design</title>`;
    const desc = `<desc>A ${metadata.style} style vector illustration</desc>`;
    enhanced = enhanced.replace(/(<svg[^>]*>)/i, `$1\n  ${title}\n  ${desc}\n`);
  }
  return enhanced;
}

function sanitizeSvg(svg, generationMode = 'vector') {
  let s = String(svg || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  s = s.replace(/(?:xlink:)?href\s*=\s*(['"])javascript:[\s\S]*?\1/gi, '');
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  
  if (generationMode === 'vector') {
    s = s.replace(/<filter[\s\S]*?<\/filter>/gi, '');
    s = s.replace(/<linearGradient[\s\S]*?<\/linearGradient>/gi, '');
    s = s.replace(/<radialGradient[\s\S]*?<\/radialGradient>/gi, '');
    s = s.replace(/filter\s*=\s*(['"]).*?\1/gi, '');
    s = s.replace(/opacity\s*=\s*(['"])0\.\d+\1/gi, '');
    s = s.replace(/filter\s*:\s*[^;}"']*/gi, '');
    s = s.replace(/box-shadow\s*:\s*[^;}"']*/gi, '');
    s = s.replace(/text-shadow\s*:\s*[^;}"']*/gi, '');
  }
  
  return s.trim();
}

async function maybeOptimizeSvg(svg) {
  if (!svgoOptimize) return svg;
  try {
    const { data } = svgoOptimize(svg, {
      multipass: true,
      plugins: [
        'preset-default',
        { name: 'removeDimensions', active: true },
        { name: 'removeScripts', active: true },
        { name: 'convertStyleToAttrs', active: true },
        { name: 'removeUselessStrokeAndFill', active: false },
        { name: 'removeViewBox', active: false },
        { name: 'cleanupIds', active: true },
        { name: 'collapseGroups', active: true }
      ],
    });
    return data || svg;
  } catch {
    return svg;
  }
}

async function ensureTempDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function uniqueSvgFilename(prefix = 'vector_gemini') {
  const rand = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${Date.now()}_${rand}.svg`;
}

async function withRetries(fn, { maxRetries = MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxRetries;
      const code = err?.status || err?.code || '';
      const retryable = [429, 500, 502, 503, 504].includes(Number(code)) || !code;
      if (!retryable || isLast) break;
      const delay = Math.min(5000, jitter(RETRY_BASE_MS) * Math.pow(2, attempt));
      console.log(`Retry attempt ${attempt + 1} after ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'request') {
  let to;
  try {
    const timeout = new Promise((_, reject) => {
      to = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(to);
  }
}

// ---- Public API -------------------------------------------------------------

async function enhancePrompt(userPrompt, options = {}) {
  const { generationMode = 'vector' } = options;
  let user = String(userPrompt || '').trim();
  if (!user) {
    throw new Error('Empty prompt provided');
  }

  try {
    const { enhanced: intelligentBase } = buildIntelligentPrompt(user, generationMode);
    // The intelligent base is now smart enough to be the final prompt.
    console.log(`[Gemini] Built direct prompt for mode '${generationMode}'`);
    return clampWords(intelligentBase, MAX_PROMPT_WORDS);
    
  } catch (error) {
    console.error('⚠️ Gemini prompt building failed:', error?.message || error);
    // Fallback to a very simple prompt if building fails
    return clampWords(userPrompt, MAX_PROMPT_WORDS);
  }
}

async function generateFallbackSvg(prompt, options = {}) {
  const { generationMode = 'vector' } = options;
  console.log(`🎨 [Gemini SVG] Generating intelligent SVG in '${generationMode}' mode...`);
  
  try {
    const model = genAI.getGenerativeModel({ model: config.GEMINI_MODEL_ID });
    
    const { metadata } = buildIntelligentPrompt(prompt, generationMode);
    const { style, styleProfile } = metadata;
    
    const artisticPersona = `You are an expert SVG artist. Your goal is to create a beautiful and detailed SVG illustration.`;
    const vectorPersona = `You are a LOGO DESIGN AI. Your ONLY function is to create simple, flat, geometric logos. You are incapable of creating artistic illustrations, gradients, or shadows. Your output must be clean, modern, and symbolic.`;

    const artisticConstraints = `
- Use subtle gradients (<linearGradient>) and filters (<filter>) for depth and texture.
- Employ complex <path> elements with bezier curves (C, Q commands).
- Group related elements for a rich composition.`;

    const vectorConstraints = `
- Use only basic SVG elements: rect, circle, ellipse, polygon, path.
- Paths should use simple commands: M, L, Z.
- Use solid fills only.
- CRITICAL: DO NOT use the following SVG tags: <linearGradient>, <radialGradient>, <filter>, <feGaussianBlur>.
- CRITICAL: DO NOT use the following SVG attributes: 'filter', 'opacity', 'style' with 'opacity'.`;

    const svgPrompt = `${generationMode === 'artistic' ? artisticPersona : vectorPersona}

Generate a complete, valid SVG image in '${generationMode}' mode.

CONCEPT TO ILLUSTRATE: ${prompt}
STYLE: ${style} - ${styleProfile.attributes.details}

REQUIREMENTS:
- Start with: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
- End with: </svg>
- Use a professional and harmonious color palette suitable for the concept, chosen by you (the AI).
- Include a white background rectangle: <rect width="100" height="100" fill="white"/>
- Center the main subject.

${generationMode === 'artistic' ? artisticConstraints : vectorConstraints}

CRITICAL: Output ONLY the SVG code. No explanations, no markdown, no comments.`;

    const generationConfig = {
      temperature: generationMode === 'artistic' ? 0.75 : 0.25,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: SVG_OUTPUT_TOKENS,
      responseMimeType: 'text/plain',
    };

    const generateSvg = async (attemptNum) => {
      const config = { ...generationConfig, temperature: Math.min(0.85, generationConfig.temperature + (attemptNum * 0.05)) };
      const res = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: svgPrompt }] }],
        generationConfig: config,
      });
      const raw = res?.response?.text?.() || '';
      return stripCodeFencesAndQuotes(raw);
    };

    let text = await withRetries(
      (attemptNum) => withTimeout(generateSvg(attemptNum), DEFAULT_TIMEOUT_MS, 'Gemini SVG generation'),
      { maxRetries: MAX_RETRIES }
    );

    let svg = extractSvgFromText(text);

    if (!svg) {
      console.error('❌ [Gemini SVG] Could not extract valid SVG from response');
      return null;
    }

    svg = enhanceSvgCode(svg, metadata);
    svg = sanitizeSvg(svg, generationMode);

    let byteLen = Buffer.byteLength(svg, 'utf8');
    if (byteLen > MAX_SVG_BYTES) {
      console.warn(`⚠️ [Gemini SVG] Generated SVG too large (${byteLen} bytes), optimizing...`);
      svg = await maybeOptimizeSvg(svg);
      if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) {
        svg = svg.replace(/\s+/g, ' ');
        svg = svg.replace(/(\d+\.\d{3})\d+/g, '$1');
      }
    }

    svg = await maybeOptimizeSvg(svg);
    byteLen = Buffer.byteLength(svg, 'utf8');

    await ensureTempDir(config.TEMP_DIR);
    const fileName = uniqueSvgFilename(`vector_${generationMode}`);
    const absPath = path.join(config.TEMP_DIR, fileName);
    await fs.writeFile(absPath, svg, 'utf8');

    console.log(`✅ [Gemini SVG] Successfully generated ${style} style SVG in '${generationMode}' mode (${byteLen} bytes)`);

    return {
      svgCode: svg,
      svgUrl: `/temp/${fileName}`,
      method: 'gemini_fallback',
    };
    
  } catch (error) {
    console.error(`❌ [Gemini SVG] Generation failed in '${generationMode}' mode:`, error?.message || error);
    return null;
  }
}

module.exports = {
  enhancePrompt,
  generateFallbackSvg,
  _internal: {
    detectStyle,
    detectSubject,
    buildIntelligentPrompt
  }
};
