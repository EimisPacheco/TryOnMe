const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { getFavorites, addFavorite, removeFavorite, isFavorite } = require("../services/firestore");
const storage = require("../services/storage");

// Validate productId/retailer format to prevent Firestore injection
const VALID_RETAILER = /^[a-z][a-z_]{1,29}$/;
const VALID_PRODUCT_ID = /^[A-Za-z0-9\-_]{1,100}$/;

function validateProductParams(productId, retailer) {
  if (productId && !VALID_PRODUCT_ID.test(productId)) {
    return "Invalid productId format (alphanumeric, hyphens, underscores only, max 100 chars)";
  }
  if (retailer && !VALID_RETAILER.test(retailer)) {
    return "Invalid retailer format";
  }
  return null;
}

// GET /api/favorites
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const favorites = await getFavorites(req.userId);
    console.log(`[favorites] GET — ${favorites.length} favorites found for user ${req.userId}`);

    // Generate signed URLs for try-on result images
    const enriched = await Promise.all(favorites.map(async (fav) => {
      console.log(`[favorites]   productId=${fav.productId} retailer=${fav.retailer} tryOnResultKey="${fav.tryOnResultKey || '(empty)'}"`);
      if (fav.tryOnResultKey) {
        try {
          fav.tryOnResultUrl = await storage.getSignedReadUrl(fav.tryOnResultKey, 3600);
          console.log(`[favorites]   → signed URL generated OK`);
        } catch (err) {
          console.error(`[favorites]   → signed URL FAILED:`, err.message);
        }
      }
      return fav;
    }));

    // Final check: log what we're sending back
    enriched.forEach((f, i) => {
      console.log(`[favorites]   FINAL[${i}] productId=${f.productId} retailer=${f.retailer} hasUrl=${!!f.tryOnResultUrl} urlPreview=${f.tryOnResultUrl ? f.tryOnResultUrl.substring(0, 80) + '...' : 'NONE'}`);
    });
    res.json({ favorites: enriched });
  } catch (error) {
    next(error);
  }
});

// GET /api/favorites/:productId - Check if product is favorited
router.get("/:productId", requireAuth, async (req, res, next) => {
  try {
    const favorited = await isFavorite(req.userId, req.params.productId);
    res.json({ favorited });
  } catch (error) {
    next(error);
  }
});

// POST /api/favorites
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { productTitle, productImage, productUrl, category, garmentClass, tryOnResultImage, outfitId } = req.body;
    // Backward compat: accept asin if productId not provided
    const productId = req.body.productId || req.body.asin;
    const retailer = req.body.retailer || "amazon";

    console.log(`[favorites] POST — productId=${productId}, retailer=${retailer}, hasProductImage=${!!productImage}, hasTryOnResultImage=${!!tryOnResultImage}, tryOnImageLength=${tryOnResultImage ? tryOnResultImage.length : 0}`);

    if (!productId) {
      return res.status(400).json({ error: "productId is required" });
    }

    const validationError = validateProductParams(productId, retailer);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    let tryOnResultKey = "";

    // Save try-on result image to Cloud Storage if provided
    if (tryOnResultImage) {
      tryOnResultKey = `users/${req.userId}/favorites/${retailer}_${productId}.jpg`;
      const buffer = Buffer.from(tryOnResultImage, "base64");
      await storage.uploadFile(tryOnResultKey, buffer, "image/jpeg");
    }

    const result = await addFavorite(req.userId, {
      productId,
      retailer,
      productTitle: productTitle || "",
      productImage: productImage || "",
      productUrl: productUrl || "",
      category: category || "",
      garmentClass: garmentClass || "",
      tryOnResultKey,
      outfitId: outfitId || "",
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// GET /api/favorites/:productId/image - Return the try-on result image as base64
router.get("/:productId/image", requireAuth, async (req, res, next) => {
  try {
    const retailer = req.query.retailer || "amazon";
    const key = `users/${req.userId}/favorites/${retailer}_${req.params.productId}.jpg`;
    console.log(`[favorites] GET IMAGE — key=${key}`);
    const base64 = await storage.downloadFileBase64(key);
    console.log(`[favorites] GET IMAGE OK`);
    res.set("Cache-Control", "no-store");
    res.json({ image: base64 });
  } catch (error) {
    console.error(`[favorites] GET IMAGE FAILED:`, error.message);
    res.status(404).json({ error: "Try-on image not found" });
  }
});

// DELETE /api/favorites/:productId
router.delete("/:productId", requireAuth, async (req, res, next) => {
  try {
    const result = await removeFavorite(req.userId, req.params.productId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
