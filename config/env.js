// config/env.js
'use strict';

/**
 * Centralized configuration loader + validator.
 *
 * - Loads .env (dotenv)
 * - Normalizes types (numbers, booleans, paths)
 * - Validates presence and format of critical settings
 * - Creates TEMP_DIR if missing
 * - Throws a single aggregated error when validation fails
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ---------- Helpers ----------
const toStr = (v, def = '') => (v === undefined || v === null ? def : String(v).trim());
const toInt = (v, def, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  return def;
};
const toBool = (v, def = false) => {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return def;
};
const isValidUrl = (u) => {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

// Looser patterns to avoid false negatives across providers/regions
const looksLikeGoogleApiKey = (k) => /^[A-Za-z0-9_\-]{30,100}$/.test(k || '');
const looksLikeModelId = (m) => /^[a-z0-9.\-]+$/i.test(m || '');
const looksLikeLocation = (loc) => /^[a-z]+-[a-z]+[0-9]+$/i.test(loc || ''); // e.g., us-central1

// ---------- Build raw config from env ----------
const raw = {
  // Server
  PORT: toInt(process.env.PORT, 3001, { min: 1, max: 65535 }),
  NODE_ENV: toStr(process.env.NODE_ENV, 'development'),

  // Google / Imagen / Gemini
  GEMINI_API_KEY: toStr(process.env.GEMINI_API_KEY),
  GEMINI_MODEL_ID: toStr(process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash'),
  GOOGLE_PROJECT_ID: toStr(process.env.GOOGLE_PROJECT_ID),
  GOOGLE_LOCATION: toStr(process.env.GOOGLE_LOCATION || 'us-central1'),
  IMAGEN_MODEL_ID: toStr(process.env.IMAGEN_MODEL_ID || 'imagen-4.0-generate-001'),
  // Optional override (advanced): if set, we’ll use it instead of building from location/project/model
  IMAGEN_ENDPOINT: toStr(process.env.IMAGEN_ENDPOINT || ''),

  // Recraft
  RECRAFT_API_KEY: toStr(process.env.RECRAFT_API_KEY),
  RECRAFT_HTTP_TIMEOUT_MS: toInt(process.env.RECRAFT_HTTP_TIMEOUT_MS, 30000, { min: 1000, max: 300000 }),
  RECRAFT_COOLDOWN_MINUTES: toInt(process.env.RECRAFT_COOLDOWN_MINUTES, 20, { min: 1, max: 120 }),
  RECRAFT_MAX_SVG_BYTES: toInt(process.env.RECRAFT_MAX_SVG_BYTES, 500 * 1024, { min: 10 * 1024, max: 5 * 1024 * 1024 }),

  // Freepik (supports common aliases)
  FREEPIK_API_KEY: toStr(process.env.FREEPIK_API_KEY || process.env.FREEPIK_KEY || process.env.FREEPIK_TOKEN),

  // Pipeline
  PIPELINE_TIMEOUT_MS: toInt(process.env.PIPELINE_TIMEOUT_MS, 120_000, { min: 10_000, max: 600_000 }),

  // Imagen HTTP
  IMAGEN_HTTP_TIMEOUT_MS: toInt(process.env.IMAGEN_HTTP_TIMEOUT_MS, 60000, { min: 5000, max: 300000 }),

  // Temp / cleanup
  TEMP_DIR: path.resolve(toStr(process.env.TEMP_DIR || path.join(__dirname, '..', 'temp'))),
  TEMP_RETENTION_MS: toInt(process.env.TEMP_RETENTION_MS, 60 * 60 * 1000, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 }),
  CLEANUP_INTERVAL_MS: toInt(process.env.CLEANUP_INTERVAL_MS, 15 * 60 * 1000, { min: 10_000, max: 24 * 60 * 60 * 1000 }),
  TEMP_MAX_BYTES: toInt(process.env.TEMP_MAX_BYTES, 512 * 1024 * 1024, { min: 1 * 1024 * 1024, max: 20 * 1024 * 1024 * 1024 }),
  TEMP_MAX_FILES: toInt(process.env.TEMP_MAX_FILES, 2000, { min: 10, max: 1_000_000 }),
  TEMP_ALLOWED_PREFIXES: toStr(process.env.TEMP_ALLOWED_PREFIXES || 'imagen_,vector_,vector_gemini_,vector_recraft_,gsa-'),

  // Security
  CORS_ALLOWED_ORIGINS: toStr(process.env.CORS_ALLOWED_ORIGINS || ''),
  TEMP_ACCESS_TOKEN: toStr(process.env.TEMP_ACCESS_TOKEN || ''),

  // Flags
  ENABLE_PROMETHEUS: toBool(process.env.ENABLE_PROMETHEUS, false),
};

// ---------- Validate + normalize ----------
function validateConfig(cfg) {
  const errors = [];
  const warnings = [];

  // Required presence
  if (!cfg.GOOGLE_PROJECT_ID) errors.push('GOOGLE_PROJECT_ID is required.');
  if (!cfg.RECRAFT_API_KEY) warnings.push('RECRAFT_API_KEY is missing — Recraft calls will fail unless local fallback is available.');
  if (!cfg.GEMINI_API_KEY) warnings.push('GEMINI_API_KEY is missing — Gemini-based features will degrade.');
  if (!cfg.FREEPIK_API_KEY) warnings.push('FREEPIK_API_KEY is missing — Freepik-based features will be disabled.');

  // Port
  if (!(cfg.PORT >= 1 && cfg.PORT <= 65535)) errors.push('PORT must be between 1 and 65535');

  // API keys format (best-effort)
  if (cfg.GEMINI_API_KEY && !looksLikeGoogleApiKey(cfg.GEMINI_API_KEY)) {
    warnings.push('GEMINI_API_KEY format looks unusual. Double-check your key.');
  }
  if (cfg.RECRAFT_API_KEY && !/^[A-Za-z0-9_\-]{20,200}$/.test(cfg.RECRAFT_API_KEY)) {
    warnings.push('RECRAFT_API_KEY format looks unusual. Double-check your key.');
  }
  if (cfg.FREEPIK_API_KEY && !/^[A-Za-z0-9_\-]{10,200}$/.test(cfg.FREEPIK_API_KEY)) {
    warnings.push('FREEPIK_API_KEY format looks unusual. Double-check your key.');
  }

  // Location / Model IDs
  if (cfg.GOOGLE_LOCATION && !looksLikeLocation(cfg.GOOGLE_LOCATION)) {
    warnings.push(`GOOGLE_LOCATION "${cfg.GOOGLE_LOCATION}" looks unusual (expected like "us-central1").`);
  }
  if (cfg.IMAGEN_MODEL_ID && !looksLikeModelId(cfg.IMAGEN_MODEL_ID)) {
    warnings.push(`IMAGEN_MODEL_ID "${cfg.IMAGEN_MODEL_ID}" looks unusual.`);
  }
  if (cfg.GEMINI_MODEL_ID && !looksLikeModelId(cfg.GEMINI_MODEL_ID)) {
    warnings.push(`GEMINI_MODEL_ID "${cfg.GEMINI_MODEL_ID}" looks unusual.`);
  }

  // Endpoint override
  if (cfg.IMAGEN_ENDPOINT && !isValidUrl(cfg.IMAGEN_ENDPOINT)) {
    errors.push('Invalid IMAGEN_ENDPOINT URL');
  }

  // Temp directory path sanity
  try {
    const resolved = path.resolve(cfg.TEMP_DIR);
    const root = path.parse(resolved).root;
    if (resolved === root) errors.push('TEMP_DIR must not be a filesystem root.');
  } catch {
    errors.push('TEMP_DIR is not a valid path.');
  }

  if (errors.length) {
    const banner = 'Configuration validation failed:';
    throw new Error(`${banner}\n- ${errors.join('\n- ')}`);
  }

  if (warnings.length) {
    console.warn('⚠️ Config warnings:\n- ' + warnings.join('\n- '));
  }

  return cfg;
}

const validated = validateConfig(raw);

// ---------- Derived values ----------
const config = {
  ...validated,
  IS_PROD: validated.NODE_ENV === 'production',
  CORS_ALLOWED_ORIGINS: validated.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
};

// ---------- Directory Setup ----------
try {
  if (!fs.existsSync(config.TEMP_DIR)) {
    console.log(`📂 Creating temporary directory at: ${config.TEMP_DIR}`);
    fs.mkdirSync(config.TEMP_DIR, { recursive: true, mode: 0o700 });
  }
} catch (e) {
  throw new Error(`Failed to prepare TEMP_DIR "${config.TEMP_DIR}": ${e.message}`);
}

module.exports = config;
