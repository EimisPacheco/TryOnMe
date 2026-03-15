const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { getProfile, deleteProfile, getFavorites, getUserVideos, removeFavorite, removeVideo } = require("../services/firestore");
const { deleteUser } = require("../services/firebaseAuth");
const storage = require("../services/storage");

// DELETE /api/account — Delete the entire user account
router.delete("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.userId;
    const email = req.userEmail;
    console.log(`[account] DELETE account requested for userId=${userId}, email=${email}`);

    // 1. Delete all Cloud Storage objects under users/{userId}/
    const prefix = `users/${userId}/`;
    await storage.deleteAllWithPrefix(prefix);
    console.log(`[account] Deleted all storage objects with prefix ${prefix}`);

    // 2. Delete all favorites from Firestore (parallel)
    const favorites = await getFavorites(userId);
    await Promise.all(favorites.map((fav) => {
      const docId = fav.retailer && fav.productId
        ? `${fav.retailer}_${fav.productId}`
        : fav.productId || fav.asin;
      return removeFavorite(userId, docId);
    }));
    console.log(`[account] Deleted ${favorites.length} favorites`);

    // 3. Delete all videos from Firestore (parallel)
    const videos = await getUserVideos(userId);
    await Promise.all(videos.map((vid) => removeVideo(userId, vid.videoId)));
    console.log(`[account] Deleted ${videos.length} video records`);

    // 4. Delete profile from Firestore
    await deleteProfile(userId);
    console.log("[account] Deleted profile record");

    // 5. Delete Firebase Auth user
    try {
      await deleteUser(userId);
      console.log("[account] Deleted Firebase Auth user");
    } catch (err) {
      console.warn("[account] Could not delete Firebase Auth user:", err.message);
    }

    console.log(`[account] Account fully deleted for ${email}`);
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
