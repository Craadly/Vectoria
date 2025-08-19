// server.js

// --- Dependencies ---
const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config/env');
const apiRoutes = require('./routes/api');
const inspirationRoutes = require('./routes/inspirationRoutes'); // Moved after requires
const { startCleanup } = require('./utils/cleanup');

// --- App Initialization ---
const app = express();

// --- Middleware Setup ---
// Increase the JSON payload limit to handle potentially large data
app.use(express.json({ limit: '50mb' }));
// Enable Cross-Origin Resource Sharing (CORS) with whitelist
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || config.CORS_ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
};
app.use(cors(corsOptions));

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

// --- API Route Handling ---
app.use('/api', apiRoutes);
// Mount inspiration routes
app.use('/api/inspiration', inspirationRoutes);

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
        - Gemini API Key:    ${config.GEMINI_API_KEY ? '✅ Loaded' : '❌ MISSING'}
        - Recraft API Key:   ${config.RECRAFT_API_KEY ? '✅ Loaded' : '❌ MISSING'}
        - Google Project ID: ${config.GOOGLE_PROJECT_ID ? '✅ Loaded' : '❌ MISSING'}
        
    🎯 INSPIRATION SERVICE: ✅ Ready
        - Extract features from Freepik URLs
        - Generate style recipes
        - Similarity checking enabled
    `);
    
    startCleanup();
});