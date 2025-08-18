// utils/cleanup.js
'use strict';

/**
 * Temp directory janitor with strong safety guarantees + directory locking.
 *
 * Features
 * - Uses `proper-lockfile` to serialize cleanup across processes/containers
 * - Fallback lockfile mechanism if `proper-lockfile` is not installed
 * - Retention window + max size / max file count caps
 * - Defense-in-depth: canonical path checks, symlink skipping, prefix allowlist
 * - Retry deletes (handles AV/Windows locks)
 * - Interval scheduler with jitter, .unref(), and stopCleanup()
 *
 * Env/config overrides
 *   TEMP_RETENTION_MS        (default: 3600000  = 60m)
 *   CLEANUP_INTERVAL_MS      (default: 900000   = 15m)
 *   TEMP_MAX_BYTES           (default: 536870912= 512MB)
 *   TEMP_MAX_FILES           (default: 2000)
 *   TEMP_ALLOWED_PREFIXES    (default: "imagen_,vector_,vector_gemini_,vector_recraft_,gsa-")
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config/env');

let lockFile = null;
try {
  // Optional: prefer proper-lockfile if available
  lockFile = require('proper-lockfile');
} catch {
  // Fallback implemented below
}

// ---- Tunables ---------------------------------------------------------------
const RETENTION_MS =
  Number(process.env.TEMP_RETENTION_MS || config.TEMP_RETENTION_MS) || 60 * 60 * 1000; // 1h

const CLEANUP_INTERVAL_MS =
  Number(process.env.CLEANUP_INTERVAL_MS || config.CLEANUP_INTERVAL_MS) || 15 * 60 * 1000; // 15m

const MAX_DIR_BYTES =
  Number(process.env.TEMP_MAX_BYTES || config.TEMP_MAX_BYTES) || 512 * 1024 * 1024; // 512MB

const MAX_DIR_FILES =
  Number(process.env.TEMP_MAX_FILES || config.TEMP_MAX_FILES) || 2000;

const ALLOWED_PREFIXES = (
  process.env.TEMP_ALLOWED_PREFIXES ||
  config.TEMP_ALLOWED_PREFIXES ||
  'imagen_,vector_,vector_gemini_,vector_recraft_,gsa-'
).split(',').map(s => s.trim()).filter(Boolean);

// Fallback lock path (only used if proper-lockfile is unavailable)
const LOCKFILE = path.join(config.TEMP_DIR, '.cleanup.lock');

let intervalHandle = null;

// ---- Helpers ----------------------------------------------------------------

/**
 * Hardened "is p within base?" check.
 * Uses realpath (canonical path) and strict prefix with a trailing separator
 * to defeat ../ traversal and symlink escape attempts.
 */
function withinDir(p, base) {
  try {
    const resolvedBase = fs.realpathSync.native(path.resolve(base));
    const resolvedPath = fs.realpathSync.native(path.resolve(p));

    const baseWithSep = resolvedBase.endsWith(path.sep)
      ? resolvedBase
      : resolvedBase + path.sep;

    return resolvedPath === resolvedBase || resolvedPath.startsWith(baseWithSep);
  } catch {
    // If realpath fails (broken link / race), treat as outside.
    return false;
  }
}

function hasAllowedPrefix(name) {
  if (ALLOWED_PREFIXES.length === 0) return true; // disabled allowlist
  return ALLOWED_PREFIXES.some(p => name.startsWith(p));
}

async function ensureTempDir() {
  await fsp.mkdir(config.TEMP_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Unlink with small retries for transient errors (Windows/AV/EP).
 */
async function safeUnlink(filePath, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.unlink(filePath);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false; // already gone
      lastErr = e;
      await sleep(150 * (i + 1));
    }
  }
  throw lastErr;
}

// ---- Locking (primary: proper-lockfile, fallback: manual) -------------------

async function acquireDirLock(dir) {
  await ensureTempDir();

  if (lockFile) {
    // User-specified behavior: use proper-lockfile with retries
    // (matches the snippet the user requested)
    const release = await lockFile.lock(dir, {
      retries: { retries: 3, minTimeout: 100 },
      // Good hygiene: avoid stale locks if process died
      stale: 30_000,
      realpath: false, // directory path is fine as-is
    });
    return { type: 'proper-lockfile', release };
  }

  // Fallback: manual exclusive file
  try {
    const handle = await fsp.open(LOCKFILE, 'wx');
    await handle.writeFile(String(Date.now()));
    return {
      type: 'manual',
      release: async () => {
        try { await handle.close(); } catch {}
        try { await fsp.unlink(LOCKFILE); } catch {}
      },
    };
  } catch (e) {
    if (e.code === 'EEXIST') return null; // someone else is running
    throw e;
  }
}

async function releaseDirLock(lock) {
  if (!lock) return;
  try {
    if (lock.type === 'proper-lockfile') {
      await lock.release();
    } else if (lock.type === 'manual') {
      await lock.release();
    }
  } catch {
    // ignore
  }
}

// ---- Core cleanup logic -----------------------------------------------------

/**
 * Performs the actual cleanup in `baseDir`.
 * Strategy:
 *   1) Delete files older than RETENTION_MS.
 *   2) If still over size/count caps, delete oldest files until within caps.
 */
async function performCleanup(baseDir, { dryRun = false } = {}) {
  const now = Date.now();

  let entries;
  try {
    entries = await fsp.readdir(baseDir, { withFileTypes: true });
  } catch (e) {
    console.error('Could not list temp directory for cleanup:', e.message);
    return { scanned: 0, deleted: 0, freedBytes: 0, remaining: 0, remainingBytes: 0, error: e.message };
  }

  // Collect candidate files (skip dirs, sockets, and symlinks)
  const files = [];
  for (const d of entries) {
    try {
      if (!d.isFile?.()) continue; // skip non-files
      if (!hasAllowedPrefix(d.name)) continue;

      const filePath = path.join(baseDir, d.name);
      if (!withinDir(filePath, baseDir)) continue; // paranoia guard

      const st = await fsp.lstat(filePath);
      if (!st.isFile()) continue;
      if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) continue;

      files.push({
        name: d.name,
        filePath,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      // ignore per-entry errors and keep going
    }
  }

  let scanned = files.length;
  let deleted = 0;
  let freedBytes = 0;

  // 1) Delete old files (by modification time)
  const oldCutoff = now - RETENTION_MS;
  const oldFiles = files.filter(f => f.mtimeMs < oldCutoff);

  for (const f of oldFiles) {
    try {
      if (!dryRun) await safeUnlink(f.filePath);
      deleted++;
      freedBytes += f.size;

      const idx = files.indexOf(f);
      if (idx >= 0) files.splice(idx, 1);

      console.log(`🗑️  Cleaned old file: ${f.name}`);
    } catch (e) {
      console.warn(`⚠️  Failed to delete ${f.name}: ${e.message}`);
    }
  }

  // 2) Enforce size and count caps: delete oldest first until within limits
  let totalBytes = files.reduce((a, b) => a + b.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  while ((files.length > MAX_DIR_FILES || totalBytes > MAX_DIR_BYTES) && files.length) {
    const f = files.shift();
    try {
      if (!dryRun) await safeUnlink(f.filePath);
      deleted++;
      freedBytes += f.size;
      totalBytes -= f.size;
      console.log(`🧹 Trimmed file: ${f.name}`);
    } catch (e) {
      console.warn(`⚠️  Failed to trim ${f.name}: ${e.message}`);
    }
  }

  const remaining = files.length;
  const remainingBytes = files.reduce((a, b) => a + b.size, 0);

  const summary = { scanned, deleted, freedBytes, remaining, remainingBytes };
  console.log(
    `🧽 Temp cleanup: scanned=${scanned}, deleted=${deleted}, ` +
    `freed=${Math.round(freedBytes / 1024)}KB, remaining=${remaining}, ` +
    `remainingBytes=${Math.round(remainingBytes / 1024)}KB`
  );
  if (dryRun) console.log('ℹ️  Dry-run mode: no files were actually deleted.');

  return summary;
}

/**
 * Public cleanup with lock — primary entry point.
 */
async function cleanupWithLock(directory = config.TEMP_DIR, opts = {}) {
  const lock = await acquireDirLock(directory);
  if (!lock) {
    return { scanned: 0, deleted: 0, freedBytes: 0, remaining: 0, remainingBytes: 0, skipped: 'locked' };
  }

  try {
    return await performCleanup(directory, opts);
  } finally {
    await releaseDirLock(lock);
  }
}

/**
 * Backward-compat name used elsewhere.
 */
async function cleanupTempDir(opts = {}) {
  return cleanupWithLock(config.TEMP_DIR, opts);
}

// ---- Scheduler --------------------------------------------------------------
/**
 * Start periodic cleanup. Runs once immediately, then on an interval with jitter.
 * Returns a function you can call to stop the scheduler.
 */
function startCleanup() {
  // Run once on start
  cleanupTempDir().catch(e => console.error('Cleanup (initial) failed:', e.message));

  // Add small jitter (±20%) to avoid synchronized cleanup across replicas
  const base = CLEANUP_INTERVAL_MS;
  const jittered = Math.max(1_000, Math.floor(base * (0.9 + Math.random() * 0.2)));

  intervalHandle = setInterval(() => {
    cleanupTempDir().catch(e => console.error('Cleanup (interval) failed:', e.message));
  }, jittered);

  // Do not keep the Node.js event loop alive because of this timer
  intervalHandle.unref?.();

  console.log(
    `🕒 Cleanup scheduler started: retention=${Math.round(RETENTION_MS / 60000)}m, ` +
    `interval≈${Math.round(jittered / 60000)}m, maxSize=${Math.round(MAX_DIR_BYTES / (1024 * 1024))}MB, ` +
    `maxFiles=${MAX_DIR_FILES}, prefixes=[${ALLOWED_PREFIXES.join(', ')}]`
  );

  return stopCleanup;
}

function stopCleanup() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('🛑 Cleanup scheduler stopped.');
  }
}

module.exports = {
  startCleanup,
  stopCleanup,
  cleanupTempDir,
  cleanupWithLock,     // explicit name matching the user's snippet
  // Expose internals for testing
  _internals: { withinDir, hasAllowedPrefix, performCleanup },
};
