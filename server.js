// server.js

// --- Dependencies ---
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config/env');
const apiRoutes = require('./routes/api');
const inspirationRoutes = require('./routes/inspirationRoutes');
const { startCleanup } = require('./utils/cleanup');

// --- App Initialization ---
const app = express();

// --- Middleware Setup ---
app.use(express.json({ limit: '50mb' }));

// ===== CORS (robust allowlist + previews) =====
const allowCredentials = ['1', 'true', 'yes'].includes(
    String(process.env.CORS_CREDENTIALS || '').toLowerCase()
);

const exactAllowlist = [
    ...(Array.isArray(config.CORS_ALLOWED_ORIGINS) ? config.CORS_ALLOWED_ORIGINS : []),
    process.env.FRONTEND_URL,
].filter(Boolean);

const patternAllowlist = [
    /^https?:\/\/.*-.*-.*\.vercel\.app$/,
    /^https?:\/\/.*--.*\.netlify\.app$/,
    /^https?:\/\/.*\.githubpreview\.dev$/,
    /^https?:\/\/.*\.app\.github\.dev$/,
    /^https?:\/\/localhost:\d+$/,
    /^https?:\/\/127\.0\.0\.1:\d+$/,
];

const corsOptions = {
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (exactAllowlist.includes(origin)) return callback(null, true);
        if (patternAllowlist.some((re) => re.test(origin))) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: allowCredentials,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// --- Static File Serving ---
app.use(express.static('public'));

// Protect access to temporary files with a simple token check
const tempAuth = (req, res, next) => {
    const token = req.query.token || req.header('x-temp-token');
    if (token && config.TEMP_ACCESS_TOKEN && token === config.TEMP_ACCESS_TOKEN) {
        return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
};
app.use('/temp', tempAuth, express.static(config.TEMP_DIR));

// ===== Back-compat alias for older clients =====
app.all('/api/generate-svg', (req, res) => {
    return res.redirect(307, '/api/generate');
});

// --- API Route Handling ---
app.use('/api', apiRoutes);
app.use('/api/inspiration', inspirationRoutes);

// --- Error Handling ---
app.use((err, req, res, next) => {
    if (err && err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'CORS forbidden for this origin' });
    }
    return next(err);
});

app.use((err, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error('[ERROR]', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// --- Server Start ---
app.listen(config.PORT, () => {
    console.log(`
  ╔════════════════════════════════════════════════════════════╗
  ║                                                            ║
  ║               🎨 VECTORIA.AI SERVER 🎨                     ║
  ║                                                            ║
  ╚════════════════════════════════════════════════════════════╝
  
  🚀 Server running at http://localhost:${config.PORT}
  
  📋 PIPELINE: Gemini -> Imagen -> Recraft
  
  📌 SERVICE STATUS:
      - Gemini API Key:     ${config.GEMINI_API_KEY ? '✅ Loaded' : '❌ MISSING'}
      - Recraft API Key:    ${config.RECRAFT_API_KEY ? '✅ Loaded' : '❌ MISSING'}
      - Freepik API Key:    ${config.FREEPIK_API_KEY ? '✅ Loaded' : '❌ MISSING'}
      - Google Project ID:  ${config.GOOGLE_PROJECT_ID ? '✅ Loaded' : '❌ MISSING'}
      
  🎯 INSPIRATION SERVICE: ✅ Ready
      - Extract features from Freepik URLs
      - Generate style recipes
      - Similarity checking enabled

  🌐 CORS:
      - Credentials:        ${allowCredentials ? '✅ Enabled' : '❌ Disabled'}
      - Exact origins:      ${exactAllowlist.length ? exactAllowlist.join(', ') : '(none)'}
  `);

    startCleanup();
});