const geminiService = require('../../services/geminiService');
const imagenService = require('../../services/imagenService');
const { vectorizeImage } = require('../../services/recraftService');
const { localVectorize, isLocalVectorizeAvailable } = require('../../utils/localVectorize');
const { nowNs, msSince, saveSvg } = require('./utils');

async function primaryPipeline(context, timings, cid) {
  const { userPrompt } = context;

  {
    const t0 = nowNs();
    console.log(`[${cid}] [1/3] Enhancing prompt…`);
    try {
      context.enhancedPrompt = await geminiService.enhancePrompt(userPrompt);
      console.log(`[${cid}] Enhanced Prompt: ${context.enhancedPrompt}`);
    } catch (e) {
      console.warn(`[${cid}] Prompt enhancement failed: ${e?.message || e}`);
      context.enhancedPrompt = userPrompt;
    } finally {
      timings.enhanceMs = msSince(t0);
    }
  }

  {
    const t0 = nowNs();
    console.log(`[${cid}] [2/3] Generating image with Imagen…`);
    try {
      context.raster = await imagenService.generateImage(context.enhancedPrompt);
      context.raster.prompt = context.enhancedPrompt;
    } catch (error) {
      console.error(`[${cid}] Raster generation failed: ${error.message}`);
      throw error;
    }
    timings.rasterMs = msSince(t0);
  }

  {
    const t0 = nowNs();
    console.log(`[${cid}] [3/3] Vectorizing image with Recraft…`);
    try {
      const vector = await vectorizeImage(context.raster);
      timings.vectorMs = msSince(t0);

      console.log(`[SUCCESS ${cid}] Primary pipeline completed (method=${vector.method || 'unknown'}).`);
      return {
        success: true,
        partial: false,
        mode: vector.method || 'full',
        svgUrl: vector.svgUrl,
        svgCode: vector.svgCode,
        rasterImageUrl: context.raster.imageUrl,
        enhancedPrompt: context.enhancedPrompt,
        originalPrompt: userPrompt,
        message:
          vector.method === 'vector_local'
            ? 'Vectorized locally. Results may differ from cloud vectorization.'
            : 'High-quality SVG design created successfully',
        correlationId: cid,
      };
    } catch (error) {
      console.error(`[${cid}] Vectorization failed: ${error.message}`);
      timings.vectorMs = msSince(t0);

      if (isLocalVectorizeAvailable()) {
        console.warn(`[${cid}] Falling back to local vectorization...`);
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
            originalPrompt: userPrompt,
            message: 'Vectorized locally. Results may differ from cloud vectorization.',
            correlationId: cid,
          };
        } catch (localError) {
          console.error(`[${cid}] Local vectorization failed: ${localError.message}`);
          throw error;
        }
      }

      throw error;
    }
  }
}

module.exports = primaryPipeline;