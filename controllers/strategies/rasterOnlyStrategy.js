async function rasterOnlyStrategy(context, _timings, cid) {
  if (!context.raster?.imageUrl) return null;

  return {
    success: true,
    partial: true,
    mode: 'raster_only',
    svgUrl: null,
    svgCode: null,
    rasterImageUrl: context.raster.imageUrl,
    enhancedPrompt: context.enhancedPrompt,
    originalPrompt: context.userPrompt,
    message: 'Vectorization temporarily unavailable. Showing raster only.',
    correlationId: cid,
  };
}

module.exports = rasterOnlyStrategy;