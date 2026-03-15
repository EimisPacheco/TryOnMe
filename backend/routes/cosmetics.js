const express = require("express");
const router = express.Router();
const { inpaint } = require("../services/imageProcessor");
const { optionalAuth } = require("../middleware/auth");
const { getProfile } = require("../services/firestore");
const storage = require("../services/storage");
const { validateBase64Image } = require("../middleware/validation");

// Whitelist of valid cosmetic colors to prevent prompt injection
const VALID_COLORS = new Set([
  "red", "dark red", "crimson", "scarlet", "cherry", "wine", "burgundy", "maroon",
  "pink", "hot pink", "light pink", "rose", "coral", "salmon", "mauve", "fuchsia",
  "nude", "beige", "natural", "peach", "tan", "caramel", "honey", "sand",
  "brown", "chocolate", "coffee", "mocha", "espresso", "bronze", "copper", "amber",
  "black", "charcoal", "dark",
  "white", "ivory", "cream",
  "blue", "navy", "teal", "turquoise", "aqua", "cobalt", "royal blue",
  "green", "olive", "emerald", "forest", "sage", "mint", "lime",
  "purple", "plum", "lavender", "violet", "eggplant", "lilac", "magenta",
  "orange", "tangerine", "apricot", "rust", "terracotta",
  "gold", "silver", "champagne", "taupe", "grey", "gray",
  "berry", "cranberry", "raspberry", "strawberry",
]);

// Mapping from cosmetic type to mask prompt
const COSMETIC_MASKS = {
  lipstick: "lips",
  eyeshadow: "eyelids and eye area",
  blush: "cheeks",
  foundation: "face skin",
  eyeliner: "eyelid edges",
  mascara: "eyelashes"
};

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    let { faceImage, cosmeticType, color } = req.body;

    // If authenticated and no faceImage provided, fetch from Cloud Storage
    if (!faceImage && req.userId) {
      const profile = await getProfile(req.userId);
      if (profile && profile.facePhotoKey) {
        faceImage = await storage.downloadFileBase64(profile.facePhotoKey);
      }
    }

    if (!faceImage || !cosmeticType || !color) {
      return res.status(400).json({ error: "faceImage, cosmeticType, and color are required" });
    }

    const imgCheck = validateBase64Image(faceImage);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid faceImage: ${imgCheck.error}` });
    }

    const maskPrompt = COSMETIC_MASKS[cosmeticType.toLowerCase()];
    if (!maskPrompt) {
      return res.status(400).json({ error: `Unsupported cosmetic type. Supported: ${Object.keys(COSMETIC_MASKS).join(", ")}` });
    }

    // Validate color against whitelist to prevent prompt injection
    const normalizedColor = color.toLowerCase().trim();
    if (!VALID_COLORS.has(normalizedColor)) {
      return res.status(400).json({ error: `Unsupported color "${color}". Use a standard makeup color (e.g. red, pink, nude, brown, coral).` });
    }

    const textPrompt = `Apply ${normalizedColor} ${cosmeticType} with natural, realistic finish. Professional makeup look.`;
    console.log(`[cosmetics] Processing - type: ${cosmeticType}, color: ${normalizedColor}, mask: ${maskPrompt}, authenticated: ${!!req.userId}`);

    const resultImage = await inpaint(faceImage, maskPrompt, textPrompt);
    res.set("Cache-Control", "no-store");
    res.json({ resultImage });
  } catch (error) {
    console.error(`[cosmetics] Error:`, error.message);
    if (error.message.includes("safety") || error.message.includes("blocked")) {
      return res.status(422).json({ error: error.message });
    }
    if (error.message.includes("failed") || error.message.includes("text instead of image")) {
      return res.status(422).json({ error: error.message });
    }
    next(error);
  }
});

module.exports = router;
