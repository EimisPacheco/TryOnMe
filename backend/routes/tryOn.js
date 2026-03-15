const express = require("express");
const router = express.Router();
const { removeBackground } = require("../services/imageProcessor");
const { virtualTryOn: geminiVirtualTryOn, virtualTryOnOutfit: geminiOutfitTryOn, extractGarment, buildSmartPrompt } = require("../services/gemini");
const { analyzeProduct, classifyOutfit, hasPersonInImage } = require("../services/classifier");
const storage = require("../services/storage");

// ---------------------------------------------------------------------------
// Shared garment preprocessing — single source of truth for all try-on flows
// Detects model/person in garment image and extracts clean garment-only version
// Fallback chain: Gemini extraction → Gemini Image Processor BG removal → original
// ---------------------------------------------------------------------------
async function preprocessGarment(imageBase64, label = "garment") {
  const debugSteps = [];

  // Step A: Person detection
  let hasPerson = false;
  let garmentDescription = null;
  try {
    console.log(`\x1b[35m  [preprocess:${label}] Checking for person in image...\x1b[0m`);
    const s = Date.now();
    const result = await hasPersonInImage(imageBase64);
    hasPerson = result.hasPerson;
    garmentDescription = result.garmentDescription;
    const t = ((Date.now() - s) / 1000).toFixed(1);
    console.log(`\x1b[36m  [preprocess:${label}] hasPerson=${hasPerson} (${t}s)\x1b[0m`);
    debugSteps.push({ step: "person-detection", hasPerson, garmentDescription, time: t + "s" });
  } catch (err) {
    console.warn(`\x1b[31m  [preprocess:${label}] Person detection failed: ${err.message}\x1b[0m`);
    debugSteps.push({ step: "person-detection", error: err.message });
  }

  if (!hasPerson) {
    return { image: imageBase64, method: "original", debugSteps };
  }

  // Step B: Gemini garment extraction (primary)
  try {
    console.log(`\x1b[35m  [preprocess:${label}] Extracting garment via Gemini...\x1b[0m`);
    const s = Date.now();
    const extracted = await extractGarment(imageBase64, garmentDescription);
    const t = ((Date.now() - s) / 1000).toFixed(1);
    if (extracted && extracted.length > 100) {
      console.log(`\x1b[32m  [preprocess:${label}] Gemini extraction SUCCESS (${t}s) — ${extracted.length} chars\x1b[0m`);
      debugSteps.push({ step: "gemini-extraction", success: true, time: t + "s" });
      return { image: extracted, method: "extracted", debugSteps };
    }
    console.warn(`\x1b[33m  [preprocess:${label}] Gemini extraction returned empty (${t}s)\x1b[0m`);
    debugSteps.push({ step: "gemini-extraction", success: false, time: t + "s", reason: "empty result" });
  } catch (err) {
    console.warn(`\x1b[31m  [preprocess:${label}] Gemini extraction failed: ${err.message}\x1b[0m`);
    debugSteps.push({ step: "gemini-extraction", success: false, error: err.message });
  }

  // Step C: Gemini Image Processor background removal (fallback)
  try {
    console.log(`\x1b[35m  [preprocess:${label}] Fallback: Gemini Image Processor BG removal...\x1b[0m`);
    const s = Date.now();
    const bgRemoved = await removeBackground(imageBase64);
    const t = ((Date.now() - s) / 1000).toFixed(1);
    if (bgRemoved && bgRemoved.length > 100) {
      console.log(`\x1b[32m  [preprocess:${label}] BG removal SUCCESS (${t}s) — ${bgRemoved.length} chars\x1b[0m`);
      debugSteps.push({ step: "bg-removal", success: true, time: t + "s" });
      return { image: bgRemoved, method: "bg-removed", debugSteps };
    }
    console.warn(`\x1b[33m  [preprocess:${label}] BG removal returned empty (${t}s)\x1b[0m`);
    debugSteps.push({ step: "bg-removal", success: false, time: t + "s", reason: "empty result" });
  } catch (err) {
    console.warn(`\x1b[31m  [preprocess:${label}] BG removal failed: ${err.message}\x1b[0m`);
    debugSteps.push({ step: "bg-removal", success: false, error: err.message });
  }

  // All preprocessing failed — use original with warning
  console.warn(`\x1b[33m  [preprocess:${label}] ⚠ All preprocessing failed — using original image with model\x1b[0m`);
  return { image: imageBase64, method: "original-with-model", debugSteps };
}
const { optionalAuth } = require("../middleware/auth");
const { getProfile } = require("../services/firestore");
const { validateBase64Image } = require("../middleware/validation");

const VALID_GARMENT_CLASSES = [
  "UPPER_BODY", "LOWER_BODY", "FULL_BODY", "FOOTWEAR",
  "LONG_SLEEVE_SHIRT", "SHORT_SLEEVE_SHIRT", "NO_SLEEVE_SHIRT",
  "LONG_PANTS", "SHORT_PANTS", "LONG_DRESS", "SHORT_DRESS",
  "FULL_BODY_OUTFIT", "SHOES", "BOOTS"
];

async function fetchPhoto(key) {
  return storage.downloadFileBase64(key);
}

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    let { sourceImage, referenceImage, garmentClass, mergeStyle, framing, poseIndex, quickMode, productTitle } = req.body;

    // If authenticated and no sourceImage provided, fetch from S3
    if (!sourceImage && req.userId) {
      const profile = await getProfile(req.userId);
      if (profile) {
        // Use selected pose from generatedPhotoKeys, fallback to bodyPhotoKey
        const idx = typeof poseIndex === "number" ? Math.max(0, Math.min(poseIndex, (profile.generatedPhotoKeys || []).length - 1)) : 0;
        if (profile.generatedPhotoKeys && profile.generatedPhotoKeys.length > 0 && profile.generatedPhotoKeys[idx]) {
          const fetched = await fetchPhoto(profile.generatedPhotoKeys[idx]);
          if (fetched) sourceImage = fetched;
        } else if (profile.bodyPhotoKey) {
          const fetched = await fetchPhoto(profile.bodyPhotoKey);
          if (fetched) sourceImage = fetched;
        }
      }
    }

    if (!sourceImage || !referenceImage) {
      return res.status(400).json({ error: "sourceImage and referenceImage are required" });
    }

    // Strip data URL prefix if present (e.g. "data:image/jpeg;base64,...")
    if (sourceImage && sourceImage.startsWith("data:")) {
      sourceImage = sourceImage.split(",")[1];
    }
    if (referenceImage && referenceImage.startsWith("data:")) {
      referenceImage = referenceImage.split(",")[1];
    }

    // Validate base64 image data
    const srcCheck = validateBase64Image(sourceImage);
    if (!srcCheck.valid) {
      return res.status(400).json({ error: `Invalid sourceImage: ${srcCheck.error}` });
    }
    const refCheck = validateBase64Image(referenceImage);
    if (!refCheck.valid) {
      return res.status(400).json({ error: `Invalid referenceImage: ${refCheck.error}` });
    }

    const provider = req.body.provider || process.env.TRYON_PROVIDER || "gemini";
    const startTime = Date.now();
    const debugSteps = [];

    console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[1m\x1b[33m║           🔥 TRY-ON REQUEST RECEIVED 🔥              ║\x1b[0m`);
    console.log(`\x1b[1m\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m`);
    console.log(`\x1b[36m  provider:\x1b[0m        \x1b[1m${provider}\x1b[0m`);
    console.log(`\x1b[36m  authenticated:\x1b[0m   ${!!req.userId}`);
    console.log(`\x1b[36m  quickMode:\x1b[0m       \x1b[1m${!!quickMode}\x1b[0m`);
    console.log(`\x1b[36m  sourceImage:\x1b[0m     ${sourceImage ? sourceImage.length : 0} chars`);
    console.log(`\x1b[36m  referenceImage:\x1b[0m  ${referenceImage ? referenceImage.length : 0} chars`);
    console.log(`\x1b[36m  garmentClass:\x1b[0m    \x1b[1m${garmentClass || "(will detect)"}\x1b[0m`);
    console.log(`\x1b[36m  framing:\x1b[0m         \x1b[1m${framing || "full"}\x1b[0m`);
    console.log(`\x1b[36m  poseIndex:\x1b[0m       \x1b[1m${poseIndex}\x1b[0m`);

    let garmentImageForTryOn = referenceImage;
    let garmentImageUsed = "original";
    let outfitInfo = { currentType: "UPPER_LOWER" };

    if (quickMode && garmentClass) {
      // ═══════════════════════════════════════════════════
      // QUICK MODE — skip steps 1-4, jump straight to generation
      // Used for chained try-on calls where garmentClass is already known
      // ═══════════════════════════════════════════════════
      console.log(`\n\x1b[1m\x1b[36m⚡ QUICK MODE — skipping steps 1-4 (garmentClass: ${garmentClass})\x1b[0m`);
      debugSteps.push({ step: "1-4", name: "SKIPPED (quickMode)", model: "N/A", time: "0s", result: { quickMode: true, garmentClass } });
    } else {

    // ═══════════════════════════════════════════════════
    // STEPS 1, 2, 3 — RUN IN PARALLEL for speed
    // Step 1: Product Analysis | Step 2: Garment Preprocessing | Step 3: Outfit Classification
    // ═══════════════════════════════════════════════════
    console.log(`\n\x1b[1m\x1b[35m▶ STEPS 1+2+3 RUNNING IN PARALLEL\x1b[0m`);
    console.log(`\x1b[90m  productTitle from frontend: ${productTitle || "(none)"}\x1b[0m`);
    const parallelStart = Date.now();

    const [step1Result, step2Result, step3Result] = await Promise.allSettled([
      // STEP 1: PRODUCT ANALYSIS
      (async () => {
        const s1 = Date.now();
        const result = await analyzeProduct(referenceImage, productTitle || "", "");
        return { result, time: ((Date.now() - s1) / 1000).toFixed(1) };
      })(),
      // STEP 2: GARMENT PREPROCESSING
      (async () => {
        const s2 = Date.now();
        const preprocessed = await preprocessGarment(referenceImage, "garment");
        return { preprocessed, time: ((Date.now() - s2) / 1000).toFixed(1) };
      })(),
      // STEP 3: OUTFIT CLASSIFICATION
      (async () => {
        const s3 = Date.now();
        const result = await classifyOutfit(sourceImage);
        return { result, time: ((Date.now() - s3) / 1000).toFixed(1) };
      })(),
    ]);

    const parallelTime = ((Date.now() - parallelStart) / 1000).toFixed(1);
    console.log(`\x1b[32m  ✓ PARALLEL STEPS COMPLETE\x1b[0m \x1b[90m(${parallelTime}s wall-clock)\x1b[0m`);

    // Process Step 1 result
    let analysisResult = null;
    if (step1Result.status === "fulfilled") {
      analysisResult = step1Result.value.result;
      if (!garmentClass && analysisResult.garmentClass) {
        garmentClass = analysisResult.garmentClass;
      }
      console.log(`\x1b[32m  ✓ STEP 1\x1b[0m \x1b[90m(${step1Result.value.time}s)\x1b[0m — garmentClass: \x1b[1m${analysisResult.garmentClass}\x1b[0m, category: ${analysisResult.category}`);
      debugSteps.push({ step: "1", name: "PRODUCT ANALYSIS", model: "Gemini Classifier", time: step1Result.value.time + "s", result: analysisResult });
    } else {
      console.warn(`\x1b[31m  ✗ STEP 1 FAILED:\x1b[0m ${step1Result.reason?.message}`);
      if (!garmentClass) garmentClass = "UPPER_BODY";
      debugSteps.push({ step: "1", name: "PRODUCT ANALYSIS", model: "Gemini Classifier", time: "0s", result: { error: step1Result.reason?.message, fallback: garmentClass } });
    }

    // Validate garmentClass
    if (!garmentClass || !VALID_GARMENT_CLASSES.includes(garmentClass)) {
      garmentClass = "UPPER_BODY";
    }

    // Process Step 2 result
    if (step2Result.status === "fulfilled") {
      garmentImageForTryOn = step2Result.value.preprocessed.image;
      garmentImageUsed = step2Result.value.preprocessed.method;
      console.log(`\x1b[32m  ✓ STEP 2\x1b[0m \x1b[90m(${step2Result.value.time}s)\x1b[0m — method: \x1b[1m${garmentImageUsed}\x1b[0m`);
      debugSteps.push({ step: "2", name: "GARMENT PREPROCESSING", time: step2Result.value.time + "s", result: { method: garmentImageUsed, substeps: step2Result.value.preprocessed.debugSteps } });
    } else {
      console.warn(`\x1b[31m  ✗ STEP 2 FAILED:\x1b[0m ${step2Result.reason?.message} — using original`);
      debugSteps.push({ step: "2", name: "GARMENT PREPROCESSING", time: "0s", result: { error: step2Result.reason?.message, method: "original" } });
    }

    // Process Step 3 result
    if (step3Result.status === "fulfilled") {
      outfitInfo = step3Result.value.result;
      console.log(`\x1b[32m  ✓ STEP 3\x1b[0m \x1b[90m(${step3Result.value.time}s)\x1b[0m — currentType: \x1b[1m${outfitInfo.currentType}\x1b[0m`);
      debugSteps.push({ step: "3", name: "OUTFIT CLASSIFICATION", model: "Gemini Classifier", time: step3Result.value.time + "s", result: outfitInfo });
    } else {
      console.warn(`\x1b[31m  ✗ STEP 3 FAILED:\x1b[0m ${step3Result.reason?.message} — using default`);
      outfitInfo = { currentType: "UPPER_LOWER" };
      debugSteps.push({ step: "3", name: "OUTFIT CLASSIFICATION", model: "Gemini Classifier", time: "0s", result: { error: step3Result.reason?.message, fallback: outfitInfo } });
    }

    } // end of non-quickMode block

    // ═══════════════════════════════════════════════════
    // STEP 4: CONFLICT MATRIX (buildSmartPrompt)
    // ═══════════════════════════════════════════════════
    const smartPrompt = buildSmartPrompt(garmentClass, outfitInfo, framing);
    const strategy = outfitInfo?.currentType === "FULL_BODY" && (garmentClass === "UPPER_BODY" || garmentClass === "LOWER_BODY") ? "CONFLICT RESOLUTION" : "STANDARD";
    console.log(`\n\x1b[1m\x1b[35m▶ STEP 4: CONFLICT MATRIX [buildSmartPrompt]\x1b[0m`);
    console.log(`\x1b[90m  ℹ Determine try-on strategy and build the context-aware prompt for Gemini\x1b[0m`);
    console.log(`\x1b[36m    strategy:\x1b[0m          \x1b[1m\x1b[33m${strategy}\x1b[0m`);
    console.log(`\x1b[36m    garmentClass:\x1b[0m      ${garmentClass}`);
    console.log(`\x1b[36m    outfitType:\x1b[0m        ${outfitInfo.currentType}`);
    console.log(`\x1b[36m    framing:\x1b[0m           \x1b[1m${framing || "full"}\x1b[0m`);
    console.log(`\x1b[36m    \x1b[1mFULL PROMPT:\x1b[0m`);
    console.log(`\x1b[33m    ${smartPrompt}\x1b[0m`);
    debugSteps.push({ step: "4", name: "CONFLICT MATRIX", model: "buildSmartPrompt", time: "0s", result: { strategy, garmentClass, outfitType: outfitInfo.currentType, prompt: smartPrompt } });

    // ═══════════════════════════════════════════════════
    // STEP 5: TRY-ON GENERATION (Gemini 2.5 Flash Image)
    // ═══════════════════════════════════════════════════
    let resultImage;
    {
      console.log(`\n\x1b[1m\x1b[35m▶ STEP 5: TRY-ON GENERATION [Gemini 2.5 Flash Image]\x1b[0m`);
      console.log(`\x1b[90m  ℹ Generate the final try-on image — put the garment on the user's body\x1b[0m`);
      console.log(`\x1b[36m    sourceImage:\x1b[0m       ${sourceImage.length} chars (user body)`);
      console.log(`\x1b[36m    garmentImage:\x1b[0m      ${garmentImageForTryOn.length} chars (${garmentImageUsed})`);
      const s5 = Date.now();
      resultImage = await geminiVirtualTryOn(sourceImage, garmentImageForTryOn, garmentClass, outfitInfo, framing);
      const s5t = ((Date.now() - s5) / 1000).toFixed(1);
      console.log(`\x1b[32m  ✓ STEP 5 COMPLETE\x1b[0m \x1b[90m(${s5t}s)\x1b[0m — result: ${resultImage ? resultImage.length : 0} chars`);
      debugSteps.push({ step: "5", name: "TRY-ON GENERATION", model: "Gemini 2.5 Flash Image", time: s5t + "s", result: { imageLength: resultImage ? resultImage.length : 0 } });
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\x1b[1m\x1b[32m╔══════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[1m\x1b[32m║         ✅ TRY-ON COMPLETE — ${totalTime}s total               ║\x1b[0m`);
    console.log(`\x1b[1m\x1b[32m╚══════════════════════════════════════════════════════╝\x1b[0m\n`);

    res.set("Cache-Control", "no-store");
    res.json({
      resultImage,
      garmentImageUsed,
      debug: {
        steps: debugSteps,
        garmentImageUsed,
        totalTime: totalTime + "s",
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /outfit — Multi-garment try-on in a single Gemini call.
 * Body: { garments: [{ imageBase64, garmentClass, label }], framing, poseIndex }
 */
router.post("/outfit", optionalAuth, async (req, res, next) => {
  try {
    let { sourceImage, garments, framing, poseIndex } = req.body;

    if (!garments || !garments.length) {
      return res.status(400).json({ error: "garments array is required" });
    }

    // Validate garment images
    for (let i = 0; i < garments.length; i++) {
      if (garments[i].imageBase64) {
        const check = validateBase64Image(garments[i].imageBase64);
        if (!check.valid) {
          return res.status(400).json({ error: `Invalid garment image ${i + 1}: ${check.error}` });
        }
      }
    }

    // If no sourceImage, fetch from S3; also fetch face reference photos for identity
    let faceReferenceImages = [];
    if (!sourceImage && req.userId) {
      const profile = await getProfile(req.userId);
      if (profile) {
        const idx = typeof poseIndex === "number" ? poseIndex : 0;
        if (profile.generatedPhotoKeys && profile.generatedPhotoKeys[idx]) {
          sourceImage = await fetchPhoto(profile.generatedPhotoKeys[idx]);
        } else if (profile.bodyPhotoKey) {
          sourceImage = await fetchPhoto(profile.bodyPhotoKey);
        }
        // Fetch original face photos as identity anchors
        const faceKeys = (profile.originalPhotoKeys || []).filter((_, i) => i >= 3); // indices 3,4 are face photos
        for (const key of faceKeys) {
          try {
            const faceImg = await fetchPhoto(key);
            if (faceImg && faceImg.length > 100) faceReferenceImages.push(faceImg);
          } catch (_) {}
        }
        console.log(`\x1b[36m  faceReferences:\x1b[0m  ${faceReferenceImages.length} loaded`);
      }
    }

    if (!sourceImage) {
      return res.status(400).json({ error: "sourceImage is required (or be authenticated with photos)" });
    }

    // Strip data URI prefix
    if (sourceImage.startsWith("data:")) {
      sourceImage = sourceImage.split(",")[1];
    }
    garments.forEach((g) => {
      if (g.imageBase64 && g.imageBase64.startsWith("data:")) {
        g.imageBase64 = g.imageBase64.split(",")[1];
      }
    });

    const startTime = Date.now();

    console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[1m\x1b[33m║        🔥 OUTFIT TRY-ON REQUEST (SINGLE CALL) 🔥     ║\x1b[0m`);
    console.log(`\x1b[1m\x1b[33m╚══════════════════════════════════════════════════════╝\x1b[0m`);
    console.log(`\x1b[36m  garments:\x1b[0m        \x1b[1m${garments.length}\x1b[0m`);
    garments.forEach((g, i) => {
      console.log(`\x1b[36m    [${i}]:\x1b[0m ${g.garmentClass} (${g.label}) — ${g.imageBase64?.length || 0} chars`);
    });
    console.log(`\x1b[36m  sourceImage:\x1b[0m     ${sourceImage.length} chars`);
    console.log(`\x1b[36m  framing:\x1b[0m         \x1b[1m${framing || "full"}\x1b[0m`);

    // Preprocess all garment images in parallel (same pipeline as single try-on)
    console.log(`\n\x1b[1m\x1b[35m▶ GARMENT PREPROCESSING [shared pipeline × ${garments.length}]\x1b[0m`);
    const preprocessResults = await Promise.allSettled(
      garments.map((g) => preprocessGarment(g.imageBase64, g.label))
    );
    for (let i = 0; i < garments.length; i++) {
      const result = preprocessResults[i];
      if (result.status === "fulfilled") {
        garments[i].imageBase64 = result.value.image;
        console.log(`\x1b[36m    [${i}] ${garments[i].label}:\x1b[0m method=\x1b[1m${result.value.method}\x1b[0m`);
      } else {
        // Preprocessing failed — use original image as fallback
        console.warn(`\x1b[33m    [${i}] ${garments[i].label}: preprocessing failed (${result.reason?.message || "unknown"}), using original\x1b[0m`);
      }
    }

    const resultImage = await geminiOutfitTryOn(sourceImage, garments, framing, faceReferenceImages);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\x1b[1m\x1b[32m╔══════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[1m\x1b[32m║      ✅ OUTFIT TRY-ON COMPLETE — ${totalTime}s total            ║\x1b[0m`);
    console.log(`\x1b[1m\x1b[32m╚══════════════════════════════════════════════════════╝\x1b[0m\n`);

    res.set("Cache-Control", "no-store");
    res.json({ resultImage, totalTime: totalTime + "s" });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
