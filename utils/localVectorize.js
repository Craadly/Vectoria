// utils/localVectorize.js
'use strict';

/**
 * Local (offline) image → SVG vectorization using Potrace.
 * - Accepts a file path or a Buffer.
 * - Optionally pre-resizes & thresholds with Sharp (if installed).
 * - Returns an SVG string (optionally optimized with SVGO if available).
 *
 * Usage:
 *   const { localVectorize, isLocalVectorizeAvailable } = require('./utils/localVectorize');
 *   const svg = await localVectorize('/path/to/image.png', { threshold: 180 });
 */

const fs = require('fs').promises;
const path = require('path');

// Optional deps (used if present)
let sharp = null;
try { sharp = require('sharp'); } catch { /* optional */ }

let potrace = null;
try { potrace = require('potrace'); } catch { /* optional */ }

let svgoOptimize = null;
try { svgoOptimize = require('svgo').optimize; } catch { /* optional */ }

// -------------------- Defaults & helpers --------------------

const DEFAULTS = Object.freeze({
  // Preprocess
  resizeMax: 1024,         // longest side (px); set null/0 to skip
  threshold: 180,          // 0..255; higher → more white, fewer shapes
  // Potrace
  turdSize: 50,            // suppress small speckles; lower → more detail
  turnPolicy: 'minority',  // 'black','white','left','right','minority','majority'
  alphaMax: 1.0,           // curve optimization; lower → fewer nodes
  optCurve: true,
  optTolerance: 0.2,
  color: '#000000',        // foreground path color
  background: '#ffffff',   // background fill
  invert: false,           // invert black/white interpretation
  // Output
  svgo: true               // run SVGO if available
});

/**
 * Returns true if both potrace and (optionally) sharp are available.
 * sharp is not required, but highly recommended for better results.
 */
function isLocalVectorizeAvailable() {
  return !!potrace;
}

/**
 * Preprocess image with Sharp (if installed):
 *  - resize down to {resizeMax} (fit=inside)
 *  - grayscale + threshold
 *  - output PNG buffer
 * If Sharp is not available, returns either the original buffer or the file path (string)
 * so that Potrace can read it directly.
 */
async function preprocess(input, opts) {
  const { resizeMax, threshold } = opts;

  // If sharp is not available, just pass through.
  if (!sharp) {
    if (Buffer.isBuffer(input)) return input;
    // Otherwise pass the file path (Potrace can read files directly)
    return String(input);
  }

  // Use Sharp pipeline
  const s = sharp(input, { failOnError: false });

  if (resizeMax && Number(resizeMax) > 0) {
    s.resize({
      width: resizeMax,
      height: resizeMax,
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  // Grayscale + threshold to help Potrace
  s.grayscale();
  if (typeof threshold === 'number') {
    s.threshold(Math.max(0, Math.min(255, threshold)));
  }

  // Output PNG (lossless, palette for smaller buffer)
  const buf = await s.png({ compressionLevel: 9, palette: true }).toBuffer();
  return buf;
}

/**
 * Promisified Potrace.trace
 */
function potraceTraceAsync(input, options) {
  return new Promise((resolve, reject) => {
    // potrace.trace accepts a Buffer or a file path
    potrace.trace(input, options, (err, svg) => {
      if (err) return reject(err);
      resolve(svg);
    });
  });
}

/**
 * Optional SVGO optimization (safe if SVGO is not installed).
 */
function optimizeSvg(svg) {
  if (!svgoOptimize) return svg;
  try {
    const { data } = svgoOptimize(svg, {
      multipass: true,
      plugins: [
        'preset-default',
        { name: 'removeDimensions', active: true },
        { name: 'cleanupNumericValues', params: { floatPrecision: 3 } },
        { name: 'convertStyleToAttrs', active: true },
      ],
    });
    return data || svg;
  } catch {
    return svg;
  }
}

// -------------------- Public API --------------------

/**
 * Vectorize an image to SVG using Potrace.
 *
 * @param {string|Buffer} input - Image file path or Buffer.
 * @param {object} [options]
 * @param {number} [options.resizeMax=1024]   - Longest side for pre-resize (px). 0/undefined to skip.
 * @param {number} [options.threshold=180]    - 0..255 binarization threshold.
 * @param {number} [options.turdSize=50]      - Potrace small-artifact suppression.
 * @param {string} [options.turnPolicy='minority'] - Potrace turn policy.
 * @param {number} [options.alphaMax=1.0]     - Curve optimization aggressiveness.
 * @param {boolean} [options.optCurve=true]   - Curve optimization.
 * @param {number} [options.optTolerance=0.2] - Curve optimization tolerance.
 * @param {string} [options.color='#000000']  - Output path color.
 * @param {string} [options.background='#ffffff'] - Output background color.
 * @param {boolean} [options.invert=false]    - Invert black/white interpretation.
 * @param {boolean} [options.svgo=true]       - Run SVGO optimization if available.
 * @returns {Promise<string>} SVG markup
 */
 async function localVectorize(input, options = {}) {
   if (!isLocalVectorizeAvailable()) {
     throw new Error(
       'Local vectorization unavailable: install "potrace" (and optionally "sharp" & "svgo").'
     );
   }
  // Accept { imageBuffer, imagePath } objects too
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
    input = input.imageBuffer ?? input.imagePath ?? input;
  }


  const opts = Object.assign({}, DEFAULTS, options);

  // 1) Preprocess (resize + grayscale + threshold)
  const pre = await preprocess(input, opts);

  // 2) Potrace trace → SVG
  const svg = await potraceTraceAsync(pre, {
    turdSize: opts.turdSize,
    turnPolicy: opts.turnPolicy,
    alphaMax: opts.alphaMax,
    optCurve: opts.optCurve,
    optTolerance: opts.optTolerance,
    color: opts.color,
    background: opts.background,
    blackOnWhite: !opts.invert,
    // If you want Potrace to perform its own thresholding (instead of Sharp):
    // threshold: opts.threshold
  });

  // 3) Optional SVGO pass
  return opts.svgo ? optimizeSvg(svg) : svg;
}

module.exports = {
  localVectorize,
  isLocalVectorizeAvailable,
  DEFAULTS
};
