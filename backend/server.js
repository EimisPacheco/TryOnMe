require("dotenv").config();

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const rateLimit = require("express-rate-limit");
const corsMiddleware = require("./middleware/cors");
const { validateImagePayload } = require("./middleware/validation");
const voiceLiveHandler = require("./routes/voiceLive");

const tryOnRoutes = require("./routes/tryOn");
const cosmeticsRoutes = require("./routes/cosmetics");
const accessoriesRoutes = require("./routes/accessories");
const analyzeRoutes = require("./routes/analyze");
const videoRoutes = require("./routes/video");
const imageRoutes = require("./routes/image");
const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profile");
const favoritesRoutes = require("./routes/favorites");
const smartSearchRoutes = require("./routes/smartSearch");
const accountRoutes = require("./routes/account");
const voiceRoutes = require("./routes/voice");
const cartRoutes = require("./routes/cart");
const shareRoutes = require("./routes/share");

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy — required on Cloud Run (behind Google load balancer) for
// express-rate-limit to correctly read client IPs from X-Forwarded-For
app.set("trust proxy", 1);

// CORS middleware - allows chrome extensions and localhost
app.use(corsMiddleware);

// JSON body parser with 50MB limit (base64 images are large)
app.use(express.json({ limit: "50mb" }));

// Request validation
app.use(validateImagePayload);

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down" },
});
app.use(globalLimiter);

// Stricter rate limit for AI-intensive endpoints
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15, // 15 AI calls per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests — please wait a moment" },
});
app.use("/api/try-on", aiLimiter);
app.use("/api/cosmetics", aiLimiter);
app.use("/api/accessories", aiLimiter);
app.use("/api/video", aiLimiter);
app.use("/api/image", aiLimiter);
app.use("/api/analyze", aiLimiter);
app.use("/api/smart-search", aiLimiter);

// Auth rate limit (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 auth attempts per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts — please try again later" },
});
app.use("/api/auth", authLimiter);

// Email share rate limit (prevent spam)
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 emails per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many emails sent — please try again later" },
});
app.use("/api/share", emailLimiter);

// Request logger — logs every request with method, path, status, and duration
app.use((req, res, next) => {
  const start = Date.now();
  const { method, path } = req;
  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const level = status >= 500 ? "ERROR" : status >= 400 ? "WARN" : "INFO";
    console.log(`[${level}] ${method} ${path} → ${status} (${duration}ms)`);
  });
  next();
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Gemini TryOnMe Everything Backend",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Mount routes
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/favorites", favoritesRoutes);
app.use("/api/analyze", analyzeRoutes);
app.use("/api/try-on", tryOnRoutes);
app.use("/api/cosmetics", cosmeticsRoutes);
app.use("/api/accessories", accessoriesRoutes);
app.use("/api/video", videoRoutes);
app.use("/api/image", imageRoutes);
app.use("/api/smart-search", smartSearchRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/share", shareRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("=== Error ===");
  console.error("Path:", req.path);
  console.error("Message:", err.message);
  console.error("Stack:", err.stack);

  const statusCode = err.statusCode || 500;
  // Pass through meaningful API errors (rate limits, quota, etc.) but hide stack traces
  let clientMessage = "Internal server error";
  if (statusCode < 500) {
    clientMessage = err.message || "Internal server error";
  } else if (err.message && (err.message.includes("RESOURCE_EXHAUSTED") || err.message.includes("quota"))) {
    clientMessage = "AI service rate limit exceeded — please wait a moment and try again";
  } else if (err.message && err.message.includes("429")) {
    clientMessage = "Too many requests — please wait a moment and try again";
  }
  res.status(statusCode).json({ error: clientMessage });
});

// Create HTTP server and attach WebSocket server for voice streaming
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/voice-live" });
wss.on("connection", voiceLiveHandler);

server.listen(PORT, () => {
  console.log(`GeminiTryOnMe backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws/voice-live`);
  console.log(`GCP Project: ${process.env.GCP_PROJECT_ID ? "(configured)" : "(not set)"}`);
});
