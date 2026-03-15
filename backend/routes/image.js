const express = require("express");
const router = express.Router();
const { removeBackground } = require("../services/imageProcessor");
const { optionalAuth } = require("../middleware/auth");
const { validateBase64Image } = require("../middleware/validation");

router.post("/remove-bg", optionalAuth, async (req, res, next) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "image is required" });
    }

    const imgCheck = validateBase64Image(image);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid image: ${imgCheck.error}` });
    }

    console.log("[image] Processing background removal");
    const resultImage = await removeBackground(image);
    res.set("Cache-Control", "no-store");
    res.json({ resultImage });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
