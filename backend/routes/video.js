const express = require("express");
const router = express.Router();
const { generateVideo: grokGenerateVideo, getVideoStatus: grokGetVideoStatus } = require("../services/grok");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validateBase64Image } = require("../middleware/validation");
const { getProfile, getUserVideos, saveVideoRecord, removeVideo } = require("../services/firestore");
const storage = require("../services/storage");

// Allowed video CDN domains for SSRF prevention
const ALLOWED_VIDEO_HOSTS = ["fal.media", "v3.fal.media", "storage.googleapis.com"];
const VALID_VIDEO_ID = /^[A-Za-z0-9_\-]{1,100}$/;

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    const { image, prompt } = req.body;
    if (!image) {
      return res.status(400).json({ error: "image is required" });
    }

    const imgCheck = validateBase64Image(image);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid image: ${imgCheck.error}` });
    }

    console.log("[video] Starting video generation job - provider: grok");

    // Get user's sex for correct pronouns in default prompt
    let sex = null;
    if (req.userId) {
      try {
        const profile = await getProfile(req.userId);
        sex = profile?.sex || null;
      } catch (err) { console.warn("[video] Profile fetch failed:", err.message); }
    }

    const result = await grokGenerateVideo(image, prompt, sex);
    res.json({ jobId: result.requestId, provider: "grok" });
  } catch (error) {
    next(error);
  }
});

// GET /api/video/list — List user's saved videos with signed playback URLs
// NOTE: Must be before /:jobId to avoid "list" being treated as a jobId
router.get("/list", requireAuth, async (req, res, next) => {
  try {
    const videos = await getUserVideos(req.userId);
    console.log(`[video] GET list — ${videos.length} videos for user ${req.userId}`);

    const enriched = await Promise.all(videos.map(async (v) => {
      try {
        v.videoUrl = await storage.getSignedReadUrl(v.videoKey, 3600);
      } catch (err) {
        console.error(`[video] signed URL failed for ${v.videoKey}:`, err.message);
      }
      return v;
    }));

    res.json({ videos: enriched });
  } catch (error) {
    next(error);
  }
});

router.get("/:jobId", async (req, res, next) => {
  try {
    const jobId = decodeURIComponent(req.params.jobId);
    console.log(`[video] Checking status for job: ${jobId}, provider: grok`);

    const status = await grokGetVideoStatus(jobId);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

// POST /api/video/save — Save a video to Cloud Storage and store metadata in Firestore
router.post("/save", requireAuth, async (req, res, next) => {
  try {
    const { videoUrl, videoBase64, productTitle, productImage } = req.body;
    // Backward compat: accept asin if productId not provided
    const productId = req.body.productId || req.body.asin || "";
    const retailer = req.body.retailer || "amazon";

    if (!videoUrl && !videoBase64) {
      return res.status(400).json({ error: "videoUrl or videoBase64 is required" });
    }

    const timestamp = Date.now();
    const videoId = `video_${timestamp}`;
    const key = `users/${req.userId}/videos/${productId || "tryon"}_${timestamp}.mp4`;

    let videoBuffer;
    if (videoBase64) {
      videoBuffer = Buffer.from(videoBase64, "base64");
    } else {
      // Validate videoUrl against allowed CDN domains to prevent SSRF
      let parsedUrl;
      try {
        parsedUrl = new URL(videoUrl);
      } catch {
        return res.status(400).json({ error: "Invalid videoUrl" });
      }
      if (!ALLOWED_VIDEO_HOSTS.some((h) => parsedUrl.hostname === h || parsedUrl.hostname.endsWith("." + h))) {
        return res.status(400).json({ error: "videoUrl must be from an allowed video CDN" });
      }
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(videoUrl, { signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to fetch video: ${response.status}`);
        videoBuffer = Buffer.from(await response.arrayBuffer());
      } finally {
        clearTimeout(fetchTimeout);
      }
    }

    console.log(`[video] Saving video: ${key} (${videoBuffer.length} bytes)`);

    await storage.uploadFile(key, videoBuffer, "video/mp4");

    // Store metadata in Firestore
    const record = await saveVideoRecord(req.userId, {
      videoId,
      videoKey: key,
      productId,
      retailer,
      productTitle: productTitle || "",
      productImage: productImage || "",
    });

    console.log(`[video] Video saved: ${key}`);
    res.json({ videoKey: key, videoId: record.videoId });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/video/:videoId — Remove a saved video
router.delete("/:videoId", requireAuth, async (req, res, next) => {
  try {
    const vid = req.params.videoId;
    if (!VALID_VIDEO_ID.test(vid)) {
      return res.status(400).json({ error: "Invalid videoId format" });
    }
    const result = await removeVideo(req.userId, vid);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
