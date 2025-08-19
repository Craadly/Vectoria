# 🎨 Vectoria – AI-Powered Vector Illustration & Icon Studio

Vectoria is an end-to-end AI pipeline that converts a textual prompt into an optimized, editable SVG asset. It orchestrates three main capabilities:

- Prompt enhancement and reasoning (Gemini) — natural-language improvement and recipe generation.
- Image synthesis (Imagen) — high-quality raster image generation used as an intermediate.
- Vectorization & optimization (Recraft) — converts raster to clean, optimized SVG ready for web and design tools.

For implementation details see [server.js](server.js) and the API routes in [routes/api.js](routes/api.js).

---

## Features

- AI-driven SVG generation (vector-first pipeline)
- Optional style inspiration extraction from Freepik-like references
- Originality/similarity checking and automatic regeneration when outputs are too similar to inspirations
- Local fallback vectorization (potrace) and robust Recraft remote vectorization
- Temp directory management and periodic cleanup with locking
- Developer-friendly API and UI (single-page frontend)

Key UX: [public/index.html](public/index.html), client logic: [public/script.js](public/script.js), styles: [public/style.css](public/style.css).

---

## How it works (pipeline)

1. Request hits the API route implemented in [routes/api.js](routes/api.js) which forwards to the generation controller implemented in [`generateWithInspiration`](controllers/enhancedGenerationController.js) and [`generateSvg`](controllers/generationController.js).
2. Optional inspiration extraction runs via [services/inspirationService.js](services/inspirationService.js) (see [`generateStyleRecipe`](services/inspirationService.js), [`checkSimilarity`](services/inspirationService.js), and `_internal` helpers such as [`_internal.processUrls`](services/inspirationService.js)).
3. Prompt enhancement is performed by Gemini logic in [services/geminiService.js](services/geminiService.js) (see [`enhancePrompt`](services/geminiService.js) and prompt-build helpers).
4. Imagen generates a raster image via [services/imagenService.js](services/imagenService.js) (see [`generateImage`](services/imagenService.js)).
5. Vectorization is performed via Recraft or local fallback; main Recraft helpers are in [services/recraftService.js](services/recraftService.js) (see [`vectorizeImage`](services/recraftService.js), and helpers like `optimizeSvg`, `sanitizeSvg`).
6. Strategy orchestration exists under [controllers/strategies/](controllers/strategies/) (see [`primaryPipeline`](controllers/strategies/primaryPipeline.js) and strategy utils in [controllers/strategies/utils.js](controllers/strategies/utils.js) including [`saveSvg`](controllers/strategies/utils.js)).

Important helpers:
- Temp cleanup and locking: [utils/cleanup.js](utils/cleanup.js) (see [`performCleanup`](utils/cleanup.js), [`cleanupWithLock`](utils/cleanup.js), and `acquireDirLock`/`releaseDirLock` logic).
- Metrics: [utils/metrics.js](utils/metrics.js) (see [`MetricsCollector.metricsMiddleware`](utils/metrics.js)).

---

## API

Primary endpoints (see [routes/api.js](routes/api.js) and sub-routes):

- POST /api/generate
  - Controller: [`generateSvg`](controllers/generationController.js)
  - Basic vector generation from prompt.

- POST /api/enhanced/generate (or equivalent)
  - Controller: [`generateWithInspiration`](controllers/enhancedGenerationController.js)
  - Supports body fields: userPrompt, inspirationUrls (array), useInspiration, checkSimilarity, style, complexity, colorMode.

- Inspiration endpoints (see [routes/inspirationRoutes.js](routes/inspirationRoutes.js)):
  - POST /api/inspiration/extract -> uses [services/inspirationService.js](services/inspirationService.js)
  - POST /api/inspiration/recipe
  - POST /api/inspiration/check-similarity

- Health & metrics:
  - GET /api/health -> [controllers/healthController.js](controllers/healthController.js)
  - Metrics middleware lives in [utils/metrics.js](utils/metrics.js).

Example cURL (quick):
```bash
curl -X POST http://localhost:3001/api/generate \
  -H "Content-Type: application/json" \
  -d '{"userPrompt":"a colorful vector rocket"}'
```

---

## Configuration & Environment

All runtime configuration is read/validated from [config/env.js](config/env.js). Required environment variables (examples):

- GEMINI_API_KEY — Gemini/GCP key
- RECRAFT_API_KEY — Recraft vectorization key
- FREEPIK_API_KEY — Freepik inspiration API key
- GOOGLE_PROJECT_ID, GOOGLE_LOCATION, IMAGEN_MODEL_ID
- TEMP_DIR, TEMP_MAX_BYTES, etc. (see [config/env.js](config/env.js))

The repository includes a `.env` example in the root (create a `.env` before running).

---

## Local development

Install dependencies and run dev server:

```bash
npm install
npm run dev
```

The SPA frontend is served from [public/index.html](public/index.html). Client-side generation flow is implemented in [public/script.js](public/script.js) — the main handler is `handleGenerate` which posts to the API.

---

## Docker

A production-oriented Dockerfile is included: [Dockerfile](Dockerfile). It builds with a multi-stage image, installs lightweight runtime deps (tini, potrace, etc.), ensures /app/temp writable and runs `node server.js`.

Build & run:
```bash
docker build -t vectoria .
docker run -p 3001:3001 --env-file .env vectoria
```

Healthcheck in the Dockerfile expects /api/health to be available.

---

## Temp files & cleanup

Temp files are written to the configured TEMP_DIR. Periodic cleanup and locking is implemented in [utils/cleanup.js](utils/cleanup.js). Exposed helpers:
- [`cleanupWithLock`](utils/cleanup.js)
- [`performCleanup`](utils/cleanup.js)
- internal safe unlink + within-dir guards to prevent accidental deletion.

---

## Error handling & observability

- Controllers log correlation IDs and timings (see [`generateSvg`](controllers/generationController.js) and [`generateWithInspiration`](controllers/enhancedGenerationController.js)).
- Metrics collection middleware: [`MetricsCollector.metricsMiddleware`](utils/metrics.js).
- Detailed Recraft error summarization is in [services/recraftService.js](services/recraftService.js) (`summarizeAxiosError`).

---

## Useful files & locations

- Server entry: [server.js](server.js)
- API routes: [routes/api.js](routes/api.js), [routes/inspirationRoutes.js](routes/inspirationRoutes.js), [routes/pipelineRoutes.js](routes/pipelineRoutes.js)
- Controllers:
  - [`generateSvg`](controllers/generationController.js)
  - [`generateWithInspiration`](controllers/enhancedGenerationController.js)
  - [controllers/healthController.js](controllers/healthController.js)
- Services:
  - [services/geminiService.js](services/geminiService.js)
  - [services/imagenService.js](services/imagenService.js)
  - [`vectorizeImage`](services/recraftService.js)
  - [services/inspirationService.js](services/inspirationService.js)
  - [services/pipelineService.js](services/pipelineService.js)
- Frontend: [public/index.html](public/index.html), [public/script.js](public/script.js), [public/style.css](public/style.css)
- Utilities: [utils/cleanup.js](utils/cleanup.js), [utils/metrics.js](utils/metrics.js)

---

## Testing & debugging

- Many services expose `_internal` helpers for unit testing (see [services/inspirationService.js](services/inspirationService.js) `_internal` exports).
- To enable debug traces set query param `?debug=1` or header `x-debug: 1` (respecting production guard in `wantDebug` — see [`generateSvg`](controllers/generationController.js)).

---

## Contributing

- Follow existing code style and tests if added.
- Keep secrets out of the repo (use `.env`).
- When adding new pipeline strategies register them under [controllers/strategies/](controllers/strategies/) and wire into the main controller flow.

---

## License

See LICENSE in the repository root (if present). If none, treat as internal by default.

---

If you want, I can:
- Expand the "API" section with exact request / response schemas for each endpoint.
- Create a shorter QuickStart README for non-developers.
- Add example Postman collection or OpenAPI spec generated from