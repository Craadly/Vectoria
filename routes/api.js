// routes/api.js
'use strict';

const express = require('express');
const router = express.Router();

const generationController = require('../controllers/generationController');
const healthController = require('../controllers/healthController');

// POST /api/generate
router.post('/generate', generationController.generateSvg);