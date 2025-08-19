// controllers/healthController.js
'use strict';

/**
 * Health controller
 *
 * - Liveness: process is up
 * - Readiness: dependencies are OK (credentials, auth init, temp dir writable, credits not in cooldown)
 * - Returns 200 for liveness always; returns 503 for degraded readiness
 * - Adds no-cache headers, runtime metadata, correlationId echo
 * - Enhanced Recraft credit cooldown reporting with remaining minutes
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const pkg = require('../package.json');
const config = require('../config/env');
const { isGoogleAuthInitialized } = require('../services/imagenService');
const { isRecraftInCooldown, recraftCooldownUntil } = require('../services/recraftService');

function bool(v) { return !!v; }

function checkTempDirWritable(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const testFile = path.join(dir, `.health_write_${Date.now()}_${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function computeStatus(checks, readiness) {
  if (!readiness) return 'healthy'; // liveness only
  return checks.every(c => c.ok) ? 'healthy' : 'degraded';
}

function statusCode(status, readiness) {
  return readiness && status !== 'healthy' ? 503 : 200;
}

function checkHealth(req, res) {
  const readiness = req.query.readiness === '1' || req.query.readiness === 'true';
  const rid =
    req.get('x-request-id') ||
    req.headers['cf-ray'] ||
    req.headers['fly-request-id'] ||
    undefined;

  // Individual checks
  const checks = [
    { name: 'gemini', ok: bool(config.GEMINI_API_KEY), reason: bool(config.GEMINI_API_KEY) ? undefined : 'GEMINI_API_KEY missing' },
    { name: 'recraft', ok: bool(config.RECRAFT_API_KEY), reason: bool(config.RECRAFT_API_KEY) ? undefined : 'RECRAFT_API_KEY missing' },
    { name: 'googleProject', ok: bool(config.GOOGLE_PROJECT_ID), reason: bool(config.GOOGLE_PROJECT_ID) ? undefined : 'GOOGLE_PROJECT_ID missing' },
    { name: 'googleAuth', ok: isGoogleAuthInitialized(), reason: isGoogleAuthInitialized() ? undefined : 'GoogleAuth not initialized' },
  ];

  // TEMP_DIR writability
  const temp = checkTempDirWritable(config.TEMP_DIR);
  checks.push({ name: 'tempDirWritable', ok: temp.ok, reason: temp.ok ? undefined : temp.reason });

  // Recraft credit cooldown - with detailed remaining time
  const isCooldown = isRecraftInCooldown();
  let cooldownReason = undefined;
  
  if (isCooldown) {
    // Calculate remaining cooldown minutes
    const cooldownEnd = recraftCooldownUntil();
    const remainingMs = Math.max(0, cooldownEnd - Date.now());
    const remainingMins = Math.ceil(remainingMs / 60000);
    cooldownReason = `credit cooldown active (${remainingMins} minute(s) remaining)`;
  }
  
  checks.push({
    name: 'recraftCredits',
    ok: !isCooldown,
    reason: cooldownReason,
  });

  const status = computeStatus(checks, readiness);
  const code = statusCode(status, readiness);

  // No-cache
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  if (rid) res.set('x-request-id', String(rid));

  return res.status(code).json({
    status,                                 // 'healthy' | 'degraded'
    mode: readiness ? 'readiness' : 'liveness',
    httpStatus: code,
    version: pkg.version || '0.0.0',
    timestamp: new Date().toISOString(),
    correlationId: rid,
    // Back-compat flags for UI
    services: {
      gemini: checks.find(c => c.name === 'gemini').ok,
      googleAuth: checks.find(c => c.name === 'googleAuth').ok,
      recraft: checks.find(c => c.name === 'recraft').ok,
      recraftCredits: checks.find(c => c.name === 'recraftCredits').ok,
    },
    // Detailed checks
    checks: checks.map(c => ({ name: c.name, ok: c.ok, reason: c.reason })),
    runtime: {
      node: process.version,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      memory: process.memoryUsage(),
      tempDir: path.resolve(config.TEMP_DIR),
      hostname: os.hostname(),
      env: process.env.NODE_ENV || 'development',
    },
  });
}

module.exports = { checkHealth };