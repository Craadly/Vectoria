// routes/inspirationRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const inspirationService = require('../services/inspirationService');
const { URL } = require('url');

// Domains allowed for inspiration URLs
const ALLOWED_DOMAINS = ['freepik.com', 'www.freepik.com', 'img.freepik.com'];


// Middleware for request validation
const validateUrls = (req, res, next) => {
  const { urls } = req.body;
  
  if (!urls || !Array.isArray(urls)) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'urls must be an array'
    });
  }
  
  if (urls.length === 0) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'urls array cannot be empty'
    });
  }
  
  if (urls.length > 10) {
    return res.status(400).json({
      error: 'Too many URLs',
      message: 'Maximum 10 URLs allowed per request'
    });
  }

  for (const urlString of urls) {
    try {
      const parsed = new URL(urlString);

      if (parsed.protocol !== 'https:') {
        return res.status(400).json({
          error: 'Invalid URL',
          message: `URL must use HTTPS: ${urlString}`
        });
      }

      const hostname = parsed.hostname.toLowerCase();
      const isAllowed = ALLOWED_DOMAINS.some(
        domain => hostname === domain || hostname.endsWith(`.${domain}`)
      );

      if (!isAllowed) {
        return res.status(400).json({
          error: 'Invalid URL',
          message: `URL domain not allowed: ${urlString}`
        });
      }
    } catch {
      return res.status(400).json({
        error: 'Invalid URL',
        message: `Invalid URL format: ${urlString}`
      });
    }
  }

  next();
};

/**
 * POST /api/inspiration/extract
 * Extract style features from Freepik URLs
 */
router.post('/extract', validateUrls, inspirationService.extractInspiration);

/**
 * POST /api/inspiration/recipe
 * Generate style recipe from Freepik URLs
 */
router.post('/recipe', validateUrls, inspirationService.generateRecipe);

/**
 * POST /api/inspiration/check-similarity
 * Check if generated output is too similar to inspiration
 */
router.post('/check-similarity', inspirationService.checkOutputSimilarity);

/**
 * GET /api/inspiration/cache-info
 * Get information about cached features
 */
router.get('/cache-info', inspirationService.getCacheInfo);

/**
 * POST /api/inspiration/clear-cache
 * Clear the feature cache
 */
router.post('/clear-cache', inspirationService.clearCache);

module.exports = router;