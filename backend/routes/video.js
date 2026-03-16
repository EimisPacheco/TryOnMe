const express = require("express");
const router = express.Router();
const { generateVideo: grokGenerateVideo, getVideoStatus: grokGetVideoStatus } = require("../services/grok");
const { generateVideo: veoGenerateVideo } = require("../services/veo");
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

// POST /api/video/veo — Generate video using Google Veo 3.1 (synchronous — waits for completion)
// Unlike Grok which returns a jobId for polling, Veo polls internally and returns the video directly.
// The response includes videoBase64 which can be used with POST /api/video/save.
router.post("/veo", optionalAuth, async (req, res, next) => {
  try {
    const { image, prompt } = req.body;
    if (!image) {
      return res.status(400).json({ error: "image is required" });
    }

    const imgCheck = validateBase64Image(image);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid image: ${imgCheck.error}` });
    }

    console.log("[video] Starting Veo 3.1 video generation (synchronous)");

    // Get user's sex for correct pronouns in default prompt
    let sex = null;
    if (req.userId) {
      try {
        const profile = await getProfile(req.userId);
        sex = profile?.sex || null;
      } catch (err) { console.warn("[video] Profile fetch failed:", err.message); }
    }

    const result = await veoGenerateVideo(image, prompt, sex);

    console.log("[video] Veo 3.1 video generation complete");
    res.json({
      status: "Completed",
      videoBase64: result.videoBase64,
      provider: "veo",
    });
  } catch (error) {
    console.error("[video] Veo generation failed:", error.message);
    next(error);
  }
});

// GET /api/video/list — List user's saved videos with signed playback URLs
// NOTE: Must be before /:jobId to avoid "list" being treated as a jobId
router.get("/list", requireAuth, async (req, res, next) => {
  try {
    const videos = await getUserVideos(req.userId);
    console.log(`[video] GET list — ${videos.length} videos for user ${req.userId}`);

    // Build video URLs using our own streaming endpoint instead of signed GCS URLs
    // (Cloud Run's default service account often lacks iam.serviceAccounts.signBlob permission)
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const enriched = videos.map((v) => {
      if (v.videoKey) {
        v.videoUrl = `${baseUrl}/api/video/stream/${encodeURIComponent(v.videoKey)}`;
      }
      return v;
    });

    res.json({ videos: enriched });
  } catch (error) {
    next(error);
  }
});

// GET /api/video/stream/:videoKey — Stream video from Cloud Storage
// Uses direct GCS download instead of signed URLs (avoids permission issues on Cloud Run)
router.get("/stream/:videoKey(*)", async (req, res, next) => {
  try {
    const videoKey = decodeURIComponent(req.params.videoKey);
    // Basic path traversal protection
    if (videoKey.includes("..")) {
      return res.status(400).json({ error: "Invalid video key" });
    }
    const buffer = await storage.downloadFile(videoKey);
    res.set("Content-Type", "video/mp4");
    res.set("Content-Length", buffer.length);
    res.set("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (error) {
    console.error(`[video] Stream failed for key ${req.params.videoKey}:`, error.message);
    res.status(404).json({ error: "Video not found" });
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
    const { videoUrl, videoBase64, productTitle, productImage, outfitItems } = req.body;
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
      // Store outfit item links (up to 6 items from outfit builder)
      ...(outfitItems && Array.isArray(outfitItems) && outfitItems.length > 0 && {
        outfitItems: outfitItems.slice(0, 6).map(item => ({
          title: (item.title || "").slice(0, 200),
          price: (item.price || "").slice(0, 20),
          productUrl: (item.productUrl || "").slice(0, 500),
          imageUrl: (item.imageUrl || "").slice(0, 500),
          category: (item.category || "").slice(0, 30),
          asin: (item.asin || "").slice(0, 20),
        })),
      }),
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
