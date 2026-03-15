const express = require("express");
const router = express.Router();
const { applyAccessory } = require("../services/imageProcessor");
const { optionalAuth } = require("../middleware/auth");
const { getProfile } = require("../services/firestore");
const storage = require("../services/storage");
const { validateBase64Image } = require("../middleware/validation");

const SUPPORTED_TYPES = ["earrings", "necklace", "bracelet", "ring", "sunglasses"];

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    let { faceImage, productImage, accessoryType } = req.body;

    // If authenticated and no faceImage provided, fetch from Cloud Storage
    if (!faceImage && req.userId) {
      const profile = await getProfile(req.userId);
      if (profile && profile.facePhotoKey) {
        faceImage = await storage.downloadFileBase64(profile.facePhotoKey);
      }
    }

    if (!faceImage || !productImage || !accessoryType) {
      return res.status(400).json({ error: "faceImage, productImage, and accessoryType are required" });
    }

    const faceCheck = validateBase64Image(faceImage);
    if (!faceCheck.valid) {
      return res.status(400).json({ error: `Invalid faceImage: ${faceCheck.error}` });
    }
    const prodCheck = validateBase64Image(productImage);
    if (!prodCheck.valid) {
      return res.status(400).json({ error: `Invalid productImage: ${prodCheck.error}` });
    }

    const type = accessoryType.toLowerCase();
    if (!SUPPORTED_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unsupported accessory type. Supported: ${SUPPORTED_TYPES.join(", ")}` });
    }

    console.log(`[accessories] Processing - type: ${type}, authenticated: ${!!req.userId}`);

    const resultImage = await applyAccessory(faceImage, productImage, type);
    res.set("Cache-Control", "no-store");
    res.json({ resultImage });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
