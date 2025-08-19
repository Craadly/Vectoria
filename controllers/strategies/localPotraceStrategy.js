const { localVectorize, isLocalVectorizeAvailable } = require('../../utils/localVectorize');
const { saveSvg } = require('./utils');

async function localPotraceStrategy(context, _timings, cid) {
  if (!context.raster) return null;
  if (!isLocalVectorizeAvailable()) return null;

  console.log(`[${cid}] Fallback: vectorizing locally via potrace…`);
  try {
    const localInput = context.raster.imageBuffer ?? context.raster.imagePath;
    const svg = await localVectorize(localInput, {
      resizeMax: 1024,
      threshold: 180,
      turdSize: 50,
      color: '#000000',
      background: '#ffffff',
      svgo: true,
    });

    const saved = await saveSvg(svg, 'vector_local', 'vector_local');
    return {
      success: true,
      partial: false,
      mode: 'vector_local',
      svgUrl: saved.svgUrl,
      svgCode: saved.svgCode,
      rasterImageUrl: context.raster.imageUrl,
      enhancedPrompt: context.enhancedPrompt,
      originalPrompt: context.userPrompt,
      message: 'Vectorized locally. Results may differ from cloud vectorization.',
      correlationId: cid,
    };
  } catch (error) {
    console.error(`[${cid}] Local vectorization failed: ${error.message}`);
    return null;
  }
}

module.exports = localPotraceStrategy;