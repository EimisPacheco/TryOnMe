const admin = require('firebase-admin');
const fs = require('fs');

// Ensure Firebase Admin is initialized (may already be initialized by firebaseAuth.js)
// Supports both file-based credentials (local dev) and ADC (Cloud Run)
if (!admin.apps.length) {
  const projectId = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const serviceAccount = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    });
  } else {
    admin.initializeApp({ projectId });
  }
}

/**
 * Required auth middleware - rejects if no valid token.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authorization token required" });
  }

  const token = authHeader.split(" ")[1];

  admin.auth().verifyIdToken(token)
    .then((decoded) => {
      req.userId = decoded.uid;
      req.userEmail = decoded.email || "";
      next();
    })
    .catch((err) => {
      console.error("[auth] Token verification failed:", err.message);
      return res.status(401).json({ error: "Invalid or expired token" });
    });
}

/**
 * Optional auth middleware - proceeds even without token, but sets req.userId if valid.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.split(" ")[1];

  admin.auth().verifyIdToken(token)
    .then((decoded) => {
      req.userId = decoded.uid;
      req.userEmail = decoded.email;
      next();
    })
    .catch((err) => {
      // Token was provided but is expired/invalid — proceed without auth
      // so the endpoint still works for unauthenticated users.
      // The client handles token refresh independently.
      console.warn("[auth] optionalAuth token invalid, proceeding without auth:", err.message);
      next();
    });
}

module.exports = { requireAuth, optionalAuth };
