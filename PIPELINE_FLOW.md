# Vectoria AI Pipeline: Complete Freepik Integration Flow

## Overview
The pipeline uses Freepik API extensively for inspiration-driven SVG generation. Here's the complete process from search to final vectorized output.

## 🔍 Phase 1: Freepik Search & Discovery

### Search Process
```javascript
// 1. Search Freepik with intelligent filtering
const results = await freepikSearch(term, limit, { freeOnly: true });
```

**API Call:**
- **Endpoint:** `GET https://api.freepik.com/v1/resources`
- **Headers:** `x-freepik-api-key`, `Accept-Language: en-US`
- **Parameters:** `term`, `limit`, `order: relevance`
- **Free-Only Filter:** URL heuristic filtering for `/free-` patterns

**Search Results Structure:**
```json
{
  "data": [
    {
      "id": "276112306",
      "title": "Modern logo design",
      "url": "https://www.freepik.com/free-vector/modern-logo_276112306.htm",
      "image": {
        "source": { "url": "https://img.freepik.com/thumb.jpg" },
        "type": "vector"
      }
    }
  ]
}
```

## 📥 Phase 2: Asset Download & Processing

### Multi-Tier Fallback Strategy

#### Tier 1: Official API Download
```javascript
// Get temporary download URL
const downloadUrl = await freepikGetDownloadUrl(resourceId);
const { buffer } = await loadRasterFromUrl(downloadUrl);
```

**API Call:**
- **Endpoint:** `GET https://api.freepik.com/v1/resources/{id}/download`
- **Returns:** Temporary signed URL for high-quality asset
- **Common Issues:** 403 for premium content, 404 for missing assets

#### Tier 2: Thumbnail Fallback
```javascript
// Use public thumbnail if download fails
const { buffer } = await loadRasterFromUrl(item.thumb);
```

**Benefits:**
- Always accessible (no premium restrictions)
- Sufficient quality for style analysis
- Fast download

#### Tier 3: Screenshot Fallback
```javascript
// Capture page screenshot as last resort
const screenshot = await captureScreenshot(item.page_url);
```

**Method:** Headless Chromium via Puppeteer
- **Resolution:** 1024x1024
- **Usage:** Style hints only (may include watermarks/UI)

## 🎨 Phase 3: Feature Extraction & Analysis

### Comprehensive Style Analysis
```javascript
const features = await extractFeaturesFromBuffer(buffer, url);
```

#### Color Analysis
- **Palette Extraction:** 8 dominant colors via Sharp
- **Color Quantization:** 32-level binning for consistency
- **Frequency Analysis:** Most common colors across references

#### Visual Characteristics
- **Brightness:** Average luminance (0-1 scale)
- **Contrast:** Dynamic range analysis
- **Edge Density:** Gradient-based edge detection
- **Vector Complexity:** Low/moderate/high classification

#### Content Categorization
- **Icons vs Illustrations:** URL pattern + aspect ratio analysis
- **Style Hints:** Geometric, organic, technical classifications
- **Perceptual Hash:** 32x32 grayscale fingerprint for similarity

### Feature Cache System
- **LRU Cache:** 100 items max
- **Cache Key:** Source URL
- **Benefits:** Avoid re-processing same assets

## 🧠 Phase 4: Prompt Enhancement

### Intelligent Style Synthesis
```javascript
const enhancedPrompt = buildEnhancedPrompt(userPrompt, extractedFeatures);
```

#### Color Palette Integration
- Aggregate top 5 colors across all references
- Generate cohesive color guidance
- Account for frequency weighting

#### Style Classification
- **Icon-Heavy:** Clean vector icon set style
- **Illustration-Heavy:** Modern flat vector illustration
- **Brightness Adaptation:** Bright/vibrant vs dark/moody
- **Complexity Hints:** Intricate detail vs simple geometric

#### Vectorization Optimization
- SVG-ready shape guidance
- Crisp edge requirements
- Background removal preparation
- Gradient limitations

## 🖼️ Phase 5: AI Generation

### Dual-Provider Strategy

#### Primary: Gemini Image Generation
```javascript
const result = await generateImageWithGemini({
  prompt: enhancedPrompt,
  referenceImages: extractedBuffers.slice(0, 3)
});
```

**Process:**
- Convert reference images to base64
- Multi-endpoint fallback (v1beta, v1)
- Inline image support for style transfer

#### Fallback: Google Imagen
```javascript
const imagen = await imagenService.generateImage(enhancedPrompt, {
  style: detectedStyle,
  analyze: false,
  skipPostProcessing: false
});
```

**Advanced Features:**
- Style profile detection (logo, minimal, geometric, etc.)
- Post-processing optimization for vectorization
- Vectorization readiness analysis

## 🎯 Phase 6: Vectorization Pipeline

### Background Removal
```javascript
const cleanPng = await recraftRemoveBg(generatedImage);
```

**Recraft API:**
- **Endpoint:** `POST https://external.api.recraft.ai/v1/images/removeBackground`
- **Format:** multipart/form-data
- **Output:** Clean PNG with transparent background

### SVG Conversion
```javascript
const svgUrl = await recraftVectorize(cleanPng);
```

**Process:**
- Trace raster to vector paths
- Optimize for web usage
- Return hosted SVG URL

## 📊 Phase 7: Response Assembly

### Comprehensive Output
```json
{
  "success": true,
  "inspirations": [
    {
      "id": "276112306",
      "title": "Modern logo design",
      "palette": ["#100100e0", "#100100100", "#e0e0e0"],
      "category": "icons",
      "brightness": 0.7,
      "edge_density": 0.12
    }
  ],
  "enhanced_prompt": "Modern logo design for Prepaidify, Style: clean vector icon set...",
  "gemini_png_bytes": 524288,
  "bg_removed_png_bytes": 445566,
  "svg_url": "https://recraft.ai/generated/vector_xyz.svg",
  "refs_used": 3
}
```

## 🔧 Error Handling & Resilience

### Premium Content Strategy
- **Detection:** 403 errors, "Premium users" messages
- **User Guidance:** Alternative search suggestions
- **Pipeline Continuity:** Thumbnail fallbacks ensure completion

### API Reliability
- **Rate Limiting:** 500ms delays between Freepik requests
- **Timeout Handling:** 15s limits with graceful degradation
- **Endpoint Fallbacks:** Multiple Gemini endpoints, Imagen backup

### Quality Assurance
- **Image Validation:** Sharp metadata checks
- **Feature Validation:** Safe defaults for extraction failures
- **Size Limits:** Recraft compatibility via Sharp preprocessing

## 🚀 Performance Optimizations

### Parallel Processing
- Color, stats, and hash extraction run concurrently
- Multiple reference processing with rate limiting
- Smart caching reduces redundant API calls

### Resource Management
- Automatic temp file cleanup
- Memory-efficient image processing
- Connection pooling for HTTP requests

---

This pipeline transforms a simple text prompt into a professionally crafted, vector-ready logo by leveraging Freepik's vast asset library for inspiration and style guidance, combined with cutting-edge AI generation and vectorization technology.
