const geminiService = require('../../services/geminiService');

async function geminiDirectStrategy(context, _timings, cid) {
  console.log(`[${cid}] Fallback: generating SVG directly with Gemini…`);
  try {
    const svg = await geminiService.generateFallbackSvg(context.enhancedPrompt || context.userPrompt);
    if (!svg) return null;

    return {
      success: true,
      partial: true,
      mode: 'fallback_svg',
      svgUrl: svg.svgUrl,
      svgCode: svg.svgCode,
      rasterImageUrl: context.raster?.imageUrl || null,
      enhancedPrompt: context.enhancedPrompt,
      originalPrompt: context.userPrompt,
      message: 'SVG design created using fallback mode',
      correlationId: cid,
    };
  } catch (error) {
    console.error(`[${cid}] Gemini direct SVG failed: ${error.message}`);
    return null;
  }
}

module.exports = geminiDirectStrategy;