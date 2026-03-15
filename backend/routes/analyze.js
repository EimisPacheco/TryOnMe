const express = require("express");
const router = express.Router();
const { analyzeProduct } = require("../services/classifier");
const { optionalAuth } = require("../middleware/auth");
const { validateBase64Image } = require("../middleware/validation");

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    const { productImage, title, breadcrumbs } = req.body;

    if (!productImage) {
      return res.status(400).json({ error: "productImage is required" });
    }

    const imgCheck = validateBase64Image(productImage);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid productImage: ${imgCheck.error}` });
    }

    console.log(`Analyzing product: ${title || "unknown"}`);
    const analysis = await analyzeProduct(
      productImage,
      title || "Unknown product",
      breadcrumbs || ""
    );

    console.log(`Analysis result: category=${analysis.category}, garmentClass=${analysis.garmentClass || "N/A"}, cosmeticType=${analysis.cosmeticType || "N/A"}, accessoryType=${analysis.accessoryType || "N/A"}`);
    res.json(analysis);
  } catch (error) {
    console.error(`[analyze] Error analyzing product "${req.body.title || "unknown"}":`, error.message);
    console.error(`[analyze] Stack:`, error.stack);
    next(error);
  }
});

module.exports = router;
