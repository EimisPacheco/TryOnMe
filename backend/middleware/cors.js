const cors = require("cors");

// Allowed extension IDs — set ALLOWED_EXTENSION_IDS env var as comma-separated list
// e.g. ALLOWED_EXTENSION_IDS=abcdef1234567890,xyz9876543210
const ALLOWED_EXTENSION_IDS = (process.env.ALLOWED_EXTENSION_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const corsMiddleware = cors({
  origin: function (origin, callback) {
    // No origin: server-to-server or same-origin — allow
    if (!origin) {
      return callback(null, true);
    }

    // Chrome extension: validate against allowlist (or allow all if none configured)
    if (origin.startsWith("chrome-extension://")) {
      if (ALLOWED_EXTENSION_IDS.length === 0) {
        // No allowlist configured — allow all extensions (dev mode)
        return callback(null, true);
      }
      const extensionId = origin.replace("chrome-extension://", "");
      if (ALLOWED_EXTENSION_IDS.includes(extensionId)) {
        return callback(null, true);
      }
      return callback(new Error("Extension not allowed by CORS"));
    }

    // Localhost dev
    if (origin.startsWith("http://localhost")) {
      return callback(null, true);
    }

    callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
});

module.exports = corsMiddleware;
