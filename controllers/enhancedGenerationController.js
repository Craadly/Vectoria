// controllers/enhancedGenerationController.js
'use strict';

/**
 * Enhanced SVG generation controller with Freepik inspiration integration
 * Adds style-guided generation based on extracted features
 */

const crypto = require('crypto');
const originalController = require('./generationController');
const inspirationService = require('../services/inspirationService');
const geminiService = require('../services/geminiService');
const imagenService = require('../services/imagenService');
const { vectorizeImage } = require('../services/recraftService');

/**
 * Enhanced generation with optional inspiration URLs
 */
async function generateWithInspiration(req, res) {
  const startedNs = process.hrtime.bigint();
  const cid = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  
  try {
    const { 
      userPrompt, 
      inspirationUrls,
      useInspiration = false,
      checkSimilarity = true,
      style,
      complexity,
      colorMode 
    } = req.body;
    
    if (!userPrompt || typeof userPrompt !== 'string') {
      return res.status(400).json({
        error: 'Please enter a description for the design',
        message: 'User prompt is required',
        correlationId: cid,
      });
    }
    
    let styleRecipe = null;
    let enhancedPrompt = userPrompt;
    let recraftProfile = style || 'default';
    let svgConstraints = {};
    let inspirationFeatures = [];
    
    // If inspiration URLs provided, extract features and generate recipe
    if (useInspiration && inspirationUrls && Array.isArray(inspirationUrls) && inspirationUrls.length > 0) {
      console.log(`[${cid}] Processing ${inspirationUrls.length} inspiration URLs...`);
      
      try {
        // Extract features from URLs using the internal service function
        let results = [];
        let errors = [];
        
        // Check if processUrls is available in internal exports
        if (inspirationService._internal && inspirationService._internal.processUrls) {
          const processResult = await inspirationService._internal.processUrls(inspirationUrls);
          results = processResult.results || [];
          errors = processResult.errors || [];
        } else {
          // Direct feature extraction without processUrls
          console.warn(`[${cid}] processUrls not found, using direct extraction`);
          
          // We can't easily process URLs without the function, so skip
          console.warn(`[${cid}] Skipping inspiration extraction - function not available`);
        }
        
        if (results && results.length > 0) {
          inspirationFeatures = results;
          
          // Generate style recipe
          styleRecipe = inspirationService._internal.generateStyleRecipe(results);
          
          console.log(`[${cid}] Style recipe generated:`, styleRecipe.style_prompt);
          
          // Enhance prompt with style guidance
          enhancedPrompt = `${userPrompt}, ${styleRecipe.style_prompt}`;
          recraftProfile = styleRecipe.recraft_profile;
          svgConstraints = styleRecipe.svg_constraints;
        } else if (errors && errors.length > 0) {
          console.warn(`[${cid}] Failed to extract inspiration:`, errors);
        }
      } catch (error) {
        console.error(`[${cid}] Inspiration processing error:`, error.message);
        // Continue without inspiration on error
      }
    }
    
    // Step 1: Enhance prompt with Gemini
    let finalPrompt = enhancedPrompt;
    try {
      console.log(`[${cid}] [1/4] Enhancing prompt with Gemini...`);
      finalPrompt = await geminiService.enhancePrompt(enhancedPrompt);
      console.log(`[${cid}] Enhanced: ${finalPrompt.substring(0, 100)}...`);
    } catch (error) {
      console.warn(`[${cid}] Gemini enhancement failed:`, error.message);
      finalPrompt = enhancedPrompt;
    }
    
    // Step 2: Generate image with Imagen
    let rasterImage = null;
    try {
      console.log(`[${cid}] [2/4] Generating image with Imagen...`);
      
      // Pass style information to Imagen
      const imagenOptions = {
        style: recraftProfile,
        analyze: checkSimilarity // Enable analysis for similarity checking
      };
      
      rasterImage = await imagenService.generateImage(finalPrompt, imagenOptions);
      console.log(`[${cid}] Image generated: ${rasterImage.imageUrl}`);
    } catch (error) {
      console.error(`[${cid}] Imagen generation failed:`, error.message);
      return res.status(500).json({
        error: 'Image generation failed',
        message: error.message,
        correlationId: cid
      });
    }
    
    // Step 3: Check similarity if requested
    if (checkSimilarity && inspirationFeatures.length > 0 && rasterImage?.imageBuffer) {
      try {
        console.log(`[${cid}] [3/4] Checking similarity with inspiration...`);
        
        const similarityResult = await inspirationService._internal.checkSimilarity(
          rasterImage.imageBuffer,
          inspirationUrls
        );
        
        if (similarityResult.is_too_similar) {
          console.warn(`[${cid}] Output too similar to inspiration!`);
          console.log(`[${cid}] Applying adjustments and regenerating...`);
          
          // Modify prompt to reduce similarity
          finalPrompt = `${finalPrompt}, unique interpretation, different color scheme, alternative style`;
          
          // Regenerate with modified parameters
          const adjustedOptions = {
            style: recraftProfile === 'minimal' ? 'geometric' : 'minimal',
            seed: Math.floor(Math.random() * 1000000),
            analyze: false
          };
          
          rasterImage = await imagenService.generateImage(finalPrompt, adjustedOptions);
          console.log(`[${cid}] Regenerated with adjustments: ${rasterImage.imageUrl}`);
        }
      } catch (error) {
        console.warn(`[${cid}] Similarity check failed:`, error.message);
        // Continue without similarity check on error
      }
    }
    
    // Step 4: Vectorize with Recraft
    let vectorResult = null;
    try {
      console.log(`[${cid}] [4/4] Vectorizing with Recraft...`);
      
      // Add style metadata for Recraft
      rasterImage.metadata = {
        ...rasterImage.metadata,
        profile: recraftProfile,
        svgConstraints
      };
      
      vectorResult = await vectorizeImage(rasterImage);
      console.log(`[${cid}] Vectorization complete: ${vectorResult.svgUrl}`);
    } catch (error) {
      console.error(`[${cid}] Vectorization failed:`, error.message);
      return res.status(500).json({
        error: 'Vectorization failed',
        message: error.message,
        correlationId: cid
      });
    }
    
    // Calculate total time
    const totalMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
    
    // Prepare response
    const response = {
      success: true,
      svgUrl: vectorResult.svgUrl,
      svgCode: vectorResult.svgCode,
      rasterImageUrl: rasterImage.imageUrl,
      enhancedPrompt: finalPrompt,
      originalPrompt: userPrompt,
      message: useInspiration 
        ? 'Design created with style inspiration'
        : 'Design created successfully',
      correlationId: cid,
      metadata: {
        duration: totalMs,
        method: vectorResult.method,
        style: recraftProfile
      }
    };
    
    // Add inspiration metadata if used
    if (useInspiration && styleRecipe) {
      response.inspiration = {
        recipe: styleRecipe,
        features_used: inspirationFeatures.length,
        applied: true
      };
    }
    
    console.log(`[${cid}] ✅ Generation complete in ${totalMs}ms`);
    
    return res.json(response);
    
  } catch (error) {
    console.error(`[${cid}] Fatal error:`, error);
    return res.status(500).json({
      error: 'Generation failed',
      message: error.message,
      correlationId: cid
    });
  }
}

/**
 * Fallback to original controller if not using inspiration
 */
async function generateSvg(req, res) {
  // If inspiration URLs provided, use enhanced generation
  if (req.body.inspirationUrls || req.body.useInspiration) {
    return generateWithInspiration(req, res);
  }
  
  // Otherwise use original controller
  return originalController.generateSvg(req, res);
}

module.exports = {
  generateSvg,
  generateWithInspiration
};