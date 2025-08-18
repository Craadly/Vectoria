// routes/api.js - Updated version with inspiration support
'use strict';

const express = require('express');
const crypto = require('crypto');
// Use the enhanced controller instead of the basic one
const generationController = require('../controllers/enhancedGenerationController');
const healthController = require('../controllers/healthController');
const config = require('../config/env');

const router = express.Router();

// ---------- Helpers ----------
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Optional rate limiter (no-op if dependency missing)
let rateLimit = () => (req, res, next) => next();
try {
  const rl = require('express-rate-limit');
  rateLimit = (opts) => rl.rateLimit({
    windowMs: opts?.windowMs ?? config.RATE_LIMIT_WINDOW_MS ?? 60_000,
    max: opts?.max ?? config.RATE_LIMIT_MAX ?? 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
} catch { /* express-rate-limit not installed; skipping */ }

// Simple CORS allowlist using config.CORS_ALLOWED_ORIGINS
function corsAllowlist(req, res, next) {
  const origins = config.CORS_ALLOWED_ORIGINS || [];
  if (!origins.length) return next();

  const origin = req.headers.origin;
  if (origins.includes('*') || origins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// Attach/propagate a request ID
function attachRequestId(req, res, next) {
  const rid = req.get('x-request-id') || crypto.randomBytes(8).toString('hex');
  req.id = rid;
  res.set('x-request-id', rid);
  next();
}

// Validate /generate-svg body (enhanced for inspiration)
const MAX_PROMPT_LEN = 800;
function validateGenerateSvg(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Unsupported Media Type. Use application/json.' });
  }
  
  const userPrompt = req.body?.userPrompt;
  if (typeof userPrompt !== 'string' || !userPrompt.trim()) {
    return res.status(400).json({
      error: 'Please enter a description for the design',
      message: 'User prompt is required',
    });
  }
  
  if (userPrompt.length > MAX_PROMPT_LEN) {
    return res.status(413).json({
      error: 'Prompt too long',
      message: `Please keep your description under ${MAX_PROMPT_LEN} characters.`,
    });
  }
  
  // Validate inspiration URLs if provided
  const inspirationUrls = req.body?.inspirationUrls;
  if (inspirationUrls) {
    if (!Array.isArray(inspirationUrls)) {
      return res.status(400).json({
        error: 'Invalid inspiration URLs',
        message: 'inspirationUrls must be an array',
      });
    }
    
    if (inspirationUrls.length > 10) {
      return res.status(400).json({
        error: 'Too many inspiration URLs',
        message: 'Maximum 10 URLs allowed',
      });
    }
    
    // Basic URL validation
    for (const url of inspirationUrls) {
      if (typeof url !== 'string' || !url.startsWith('http')) {
        return res.status(400).json({
          error: 'Invalid URL in inspiration',
          message: 'All inspiration URLs must be valid HTTP(S) URLs',
        });
      }
    }
  }
  
  next();
}

// Enforce allowed methods for routes mounted under /generate-svg
function allowPostOnly(req, res, next) {
  if (req.method === 'POST' || req.method === 'OPTIONS') return next();
  res.set('Allow', 'POST, OPTIONS');
  return res.sendStatus(405);
}

// ---------- Global router middleware ----------
router.use(attachRequestId);
router.use(corsAllowlist);

// ---------- Routes ----------

// Main generation route (now supports inspiration automatically)
router.use('/generate-svg', allowPostOnly, rateLimit(), validateGenerateSvg);
router.post('/generate-svg', asyncHandler(generationController.generateSvg));

// Alternative explicit route for generation with inspiration
router.use('/generate-with-inspiration', allowPostOnly, rateLimit(), validateGenerateSvg);
router.post('/generate-with-inspiration', asyncHandler(generationController.generateWithInspiration));

// Health: never cache
router.get('/health', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}, asyncHandler(healthController.checkHealth));

module.exports = router;