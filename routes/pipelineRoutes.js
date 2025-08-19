// routes/pipelineRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const { createSvgFromSearch } = require('../services/pipelineService');

router.post('/search-generate-svg', async (req, res) => {
  try {
    const { term, n, prompt } = req.body || {};
    const result = await createSvgFromSearch({
      term,
      n: n ?? 3,
      userPrompt: prompt,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Pipeline] Error:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
