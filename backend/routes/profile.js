const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { requireAuth } = require("../middleware/auth");
const { validateBase64Image } = require("../middleware/validation");
const { getProfile, putProfile } = require("../services/firestore");
const { generateProfilePhoto } = require("../services/gemini");
const storage = require("../services/storage");

// GET /api/profile
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const profile = await getProfile(req.userId);
    if (!profile) {
      return res.json({ profileComplete: false });
    }
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

// PUT /api/profile
router.put("/", requireAuth, async (req, res, next) => {
  try {
    const { birthday } = req.body;

    // Sanitize text fields: strip HTML tags, entities, and control characters
    const sanitize = (s) => {
      if (typeof s !== "string") return s;
      return s
        .replace(/<[^>]*>/g, "")           // strip HTML tags
        .replace(/&[#\w]+;/g, "")          // strip HTML entities (&amp; &#x27; etc.)
        .replace(/javascript\s*:/gi, "")   // strip javascript: URIs
        .replace(/on\w+\s*=/gi, "")        // strip inline event handlers (onclick= etc.)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "") // strip control characters
        .trim()
        .slice(0, 200);                    // enforce max length
    };

    const firstName = sanitize(req.body.firstName);
    const lastName = sanitize(req.body.lastName);
    const country = sanitize(req.body.country);
    const city = sanitize(req.body.city);
    const sex = req.body.sex === "male" || req.body.sex === "female" ? req.body.sex : undefined;
    const clothesSize = sanitize(req.body.clothesSize);
    const shoesSize = req.body.shoesSize ? String(req.body.shoesSize).trim().slice(0, 20) : undefined;

    // Calculate age from birthday
    let age = null;
    if (birthday) {
      if (typeof birthday !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(birthday)) {
        return res.status(400).json({ error: "birthday must be in YYYY-MM-DD format" });
      }
      const birthDate = new Date(birthday);
      if (isNaN(birthDate.getTime())) {
        return res.status(400).json({ error: "Invalid birthday date" });
      }
      const today = new Date();
      age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }
    }

    const existing = await getProfile(req.userId) || {};
    const profileData = {
      ...existing,
      firstName: firstName || existing.firstName,
      lastName: lastName || existing.lastName,
      birthday: birthday || existing.birthday,
      age: age !== null ? age : existing.age,
      sex: sex || existing.sex,
      clothesSize: clothesSize || existing.clothesSize,
      shoesSize: shoesSize || existing.shoesSize,
      country: country || existing.country,
      city: city || existing.city,
      email: req.userEmail || existing.email,
    };

    // Check if profile is complete
    profileData.profileComplete = !!(
      profileData.firstName &&
      profileData.lastName &&
      profileData.birthday &&
      profileData.bodyPhotoKey &&
      profileData.facePhotoKey
    );

    const result = await putProfile(req.userId, profileData);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/profile/photos
router.post("/photos", requireAuth, async (req, res, next) => {
  try {
    const { type, image } = req.body;

    if (!type || !image) {
      return res.status(400).json({ error: "type (body|face) and image (base64) are required" });
    }

    if (type !== "body" && type !== "face") {
      return res.status(400).json({ error: "type must be 'body' or 'face'" });
    }

    const imgCheck = validateBase64Image(image);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid image: ${imgCheck.error}` });
    }

    const key = `users/${req.userId}/${type}.jpg`;
    const buffer = Buffer.from(image, "base64");

    await storage.uploadFile(key, buffer, "image/jpeg");

    // Update profile with photo key
    const existing = await getProfile(req.userId) || {};
    const photoField = type === "body" ? "bodyPhotoKey" : "facePhotoKey";
    const profileData = {
      ...existing,
      [photoField]: key,
      email: req.userEmail || existing.email,
    };

    // Check if profile is complete
    profileData.profileComplete = !!(
      profileData.firstName &&
      profileData.lastName &&
      profileData.birthday &&
      profileData.bodyPhotoKey &&
      profileData.facePhotoKey
    );

    await putProfile(req.userId, profileData);

    res.json({ key, profileComplete: profileData.profileComplete });
  } catch (error) {
    next(error);
  }
});

// GET /api/profile/photo/:type - Get user photo as base64
router.get("/photo/:type", requireAuth, async (req, res, next) => {
  try {
    const { type } = req.params;
    if (type !== "body" && type !== "face") {
      return res.status(400).json({ error: "type must be 'body' or 'face'" });
    }

    const profile = await getProfile(req.userId);
    const photoKey = type === "body" ? profile?.bodyPhotoKey : profile?.facePhotoKey;

    if (!photoKey) {
      return res.status(404).json({ error: `No ${type} photo found` });
    }

    const base64 = await storage.downloadFileBase64(photoKey);
    res.set("Cache-Control", "no-store");
    res.json({ image: base64 });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/profile/generate-photos
// Receives 5 user images, generates 3 AI-posed profile photos
// ---------------------------------------------------------------------------
router.post("/generate-photos", requireAuth, async (req, res, next) => {
  try {
    const { userImages } = req.body;

    if (!userImages || !Array.isArray(userImages) || userImages.length !== 5) {
      return res.status(400).json({ error: "userImages must be an array of 5 base64 strings (3 body + 2 face)" });
    }

    // Validate that none of the 5 images are empty/null/undefined
    for (let idx = 0; idx < 5; idx++) {
      const label = idx < 3 ? `body photo ${idx + 1}` : `face photo ${idx - 2}`;
      if (!userImages[idx] || typeof userImages[idx] !== "string" || userImages[idx].length < 100) {
        return res.status(400).json({ error: `${label} is missing or invalid (image ${idx + 1} of 5)` });
      }
      const imgCheck = validateBase64Image(userImages[idx]);
      if (!imgCheck.valid) {
        return res.status(400).json({ error: `${label} invalid: ${imgCheck.error}` });
      }
    }

    console.log("\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════════╗");
    console.log("║     PROFILE PHOTO GENERATION — 3 Poses                  ║");
    console.log("╚══════════════════════════════════════════════════════════╝\x1b[0m");

    // Load pose templates from backend/assets/
    const assetsDir = path.join(__dirname, "..", "assets");
    const poseTemplateFiles = ["pose_template1.jpg", "pose_template2.jpg", "pose_template3.jpg"];
    const poseTemplates = poseTemplateFiles.map((file) => {
      const filepath = path.join(assetsDir, file);
      return fs.readFileSync(filepath).toString("base64");
    });

    // Store 5 original user images in Cloud Storage
    const originalKeys = [];
    const bodyLabels = ["original_body_0", "original_body_1", "original_body_2"];
    const faceLabels = ["original_face_0", "original_face_1"];
    const allLabels = [...bodyLabels, ...faceLabels];

    for (let i = 0; i < 5; i++) {
      const key = `users/${req.userId}/${allLabels[i]}.jpg`;
      const buffer = Buffer.from(userImages[i], "base64");
      await storage.uploadFile(key, buffer, "image/jpeg");
      originalKeys.push(key);
      console.log(`\x1b[36m  Stored: ${key} (${(buffer.length / 1024).toFixed(0)} KB)\x1b[0m`);
    }

    // Generate 3 posed profile photos (chained: pose 1 result anchors poses 2 & 3)
    const generatedPhotos = [];
    const generatedKeys = [];
    let anchorImage = null; // First generated image becomes anchor for consistency
    const totalStart = Date.now();

    // Text descriptions of each mannequin pose to help the model differentiate them
    const poseDescriptions = [
      "standing upright facing camera, hands resting at hip level, slight forward lean, weight on both feet",
      "mid-stride walking pose, left leg forward and right leg back, arms relaxed at sides, body angled slightly to the right",
      "standing facing camera, hands clasped together in front at waist level, legs slightly crossed, weight shifted to one side",
    ];

    for (let i = 0; i < 3; i++) {
      const poseLabel = `POSE ${i + 1}/3`;
      console.log(`\n\x1b[1m\x1b[35m▶ GENERATING ${poseLabel}\x1b[0m [gemini-3.1-flash-image-preview]${anchorImage ? " (with anchor)" : ""}`);
      const stepStart = Date.now();

      try {
        const resultBase64 = await generateProfilePhoto(userImages, poseTemplates[i], "image/jpeg", anchorImage, poseDescriptions[i]);
        const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
        console.log(`\x1b[32m  ✓ ${poseLabel} COMPLETE (${elapsed}s) — ${resultBase64.length} chars\x1b[0m`);

        generatedPhotos.push(resultBase64);

        // Use first successful result as anchor for subsequent poses
        if (!anchorImage) {
          anchorImage = resultBase64;
          console.log(`\x1b[36m  ↳ Set as identity anchor for remaining poses\x1b[0m`);
        }

        // Store generated image in Cloud Storage
        const key = `users/${req.userId}/generated_pose_${i}.jpg`;
        const buffer = Buffer.from(resultBase64, "base64");
        await storage.uploadFile(key, buffer, "image/jpeg");
        generatedKeys.push(key);
      } catch (err) {
        const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
        console.log(`\x1b[31m  ✗ ${poseLabel} FAILED (${elapsed}s): ${err.message}\x1b[0m`);
        generatedPhotos.push(null);
      }
    }

    const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
    const successCount = generatedPhotos.filter(Boolean).length;

    console.log(`\n\x1b[1m\x1b[33m╔══════════════════════════════════════════════════════════╗`);
    console.log(`║  ✅ PROFILE GENERATION DONE — ${successCount}/3 in ${totalElapsed}s`);
    console.log(`╚══════════════════════════════════════════════════════════╝\x1b[0m`);

    // Update profile in Firestore
    const existing = await getProfile(req.userId) || {};
    const profileData = {
      ...existing,
      originalPhotoKeys: originalKeys,
      generatedPhotoKeys: generatedKeys,
      // Set first generated photo as bodyPhotoKey for backward compat with try-on
      bodyPhotoKey: generatedKeys[0] || existing.bodyPhotoKey,
      // Set first face as facePhotoKey for backward compat
      facePhotoKey: originalKeys[3] || existing.facePhotoKey,
      email: req.userEmail || existing.email,
    };

    profileData.profileComplete = !!(
      profileData.firstName &&
      profileData.lastName &&
      profileData.birthday &&
      profileData.bodyPhotoKey &&
      profileData.facePhotoKey
    );

    await putProfile(req.userId, profileData);

    res.json({
      success: true,
      generatedPhotos,
      profileComplete: profileData.profileComplete,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/profile/photos/original/:index - Replace a specific original photo
// ---------------------------------------------------------------------------
router.put("/photos/original/:index", requireAuth, async (req, res, next) => {
  try {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index > 4) {
      return res.status(400).json({ error: "index must be 0-4" });
    }

    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "image (base64) is required" });
    }

    const imgCheck = validateBase64Image(image);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid image: ${imgCheck.error}` });
    }

    const profile = await getProfile(req.userId);
    if (!profile || !profile.originalPhotoKeys || !profile.originalPhotoKeys[index]) {
      return res.status(404).json({ error: "Original photo not found at this index" });
    }

    // Overwrite the existing key
    const key = profile.originalPhotoKeys[index];
    const buffer = Buffer.from(image, "base64");
    await storage.uploadFile(key, buffer, "image/jpeg");

    console.log(`[profile] Replaced original photo [${index}]: ${key} (${(buffer.length / 1024).toFixed(0)} KB)`);

    res.json({ success: true, index, key });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/profile/photos/all - Get all 8 photos (5 original + 3 generated)
// ---------------------------------------------------------------------------
router.get("/photos/all", requireAuth, async (req, res, next) => {
  try {
    const profile = await getProfile(req.userId);
    if (!profile) {
      return res.json({ originals: [], generated: [] });
    }

    const fetchFromStorage = async (key) => {
      try {
        return await storage.downloadFileBase64(key);
      } catch (err) {
        console.error(`[profile] Failed to fetch photo: key=${key}, error=${err.message}`);
        return null;
      }
    };

    const originals = profile.originalPhotoKeys
      ? await Promise.all(profile.originalPhotoKeys.map(fetchFromStorage))
      : [];

    const generated = profile.generatedPhotoKeys
      ? await Promise.all(profile.generatedPhotoKeys.map(fetchFromStorage))
      : [];

    res.json({ originals, generated });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
