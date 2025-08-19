const path = require('path');
const fs = require('fs').promises;
const config = require('../../config/env');
const { uniqueSvgName, generateSimpleSVG } = require('./utils');

async function emergencyFallbackStrategy(context, timings, cid) {
  console.log(`[${cid}] Emergency fallback: generating simple SVG locally...`);

  try {
    const simpleSvg = generateSimpleSVG(context.userPrompt);

    const fileName = uniqueSvgName('fallback');
    const filePath = path.join(config.TEMP_DIR, fileName);
    await fs.writeFile(filePath, simpleSvg, 'utf8');

    return {
      success: true,
      partial: true,
      mode: 'emergency_fallback',
      svgUrl: `/temp/${fileName}`,
      svgCode: simpleSvg,
      rasterImageUrl: null,
      enhancedPrompt: context.userPrompt + ' (simplified)',
      originalPrompt: context.userPrompt,
      message: 'Generated a simplified design due to service connectivity issues. Please check your API configuration.',
      correlationId: cid,
    };
  } catch (error) {
    console.error(`[${cid}] Emergency fallback failed:`, error);
    return null;
  }
}

module.exports = emergencyFallbackStrategy;