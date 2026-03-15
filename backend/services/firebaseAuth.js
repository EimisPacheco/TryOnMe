const admin = require('firebase-admin');
const fs = require('fs');

// Initialize Firebase Admin SDK (only once)
// Supports both file-based credentials (local dev) and ADC (Cloud Run)
if (!admin.apps.length) {
  const projectId = process.env.GCP_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const serviceAccount = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    });
    console.log(`[firebase] Initialized with service account credentials, project: ${projectId}`);
  } else {
    admin.initializeApp({ projectId });
    console.log(`[firebase] Initialized with ADC, project: ${projectId}`);
  }
} else {
  console.log('[firebase] Already initialized, reusing existing app');
}

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
console.log(`[firebase] API key configured: ${FIREBASE_API_KEY ? 'yes' : 'NO — login/refresh will fail!'}`);

async function signUp(email, password) {
  console.log(`[firebase] Creating user: ${email}`);
  const user = await admin.auth().createUser({
    email,
    password,
    emailVerified: true, // Auto-verify for hackathon
  });
  console.log(`[firebase] User created: ${user.uid}, emailVerified: ${user.emailVerified}`);
  return { userSub: user.uid, confirmed: true };
}

async function confirmSignUp(email, code) {
  console.log(`[firebase] confirmSignUp called for ${email} (no-op, auto-verified)`);
  return { confirmed: true };
}

async function signIn(email, password) {
  if (!FIREBASE_API_KEY) {
    console.error('[firebase] FIREBASE_API_KEY is not set — cannot sign in');
    throw new Error("FIREBASE_API_KEY is not set in environment variables");
  }
  console.log(`[firebase] Signing in: ${email}`);
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await response.json();
  if (data.error) {
    console.error(`[firebase] SignIn error: ${data.error.code} — ${data.error.message}`);
    const err = new Error(data.error.message);
    err.code = data.error.message;
    throw err;
  }
  console.log(`[firebase] SignIn success: ${email}, expiresIn: ${data.expiresIn}s`);
  return {
    idToken: data.idToken,
    accessToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresIn: parseInt(data.expiresIn),
  };
}

async function refreshTokens(refreshToken) {
  if (!FIREBASE_API_KEY) {
    console.error('[firebase] FIREBASE_API_KEY is not set — cannot refresh tokens');
    throw new Error("FIREBASE_API_KEY is not set in environment variables");
  }
  console.log('[firebase] Refreshing tokens');
  const url = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const data = await response.json();
  if (data.error) {
    console.error(`[firebase] Refresh error: ${data.error.code} — ${data.error.message}`);
    const err = new Error(data.error.message);
    err.code = data.error.message;
    throw err;
  }
  console.log('[firebase] Token refresh success');
  return {
    idToken: data.id_token,
    accessToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresIn: parseInt(data.expires_in),
  };
}

async function resendCode(email) {
  console.log(`[firebase] resendCode called for ${email} (no-op, auto-verified)`);
  return { sent: true };
}

async function deleteUser(userId) {
  console.log(`[firebase] Deleting user: ${userId}`);
  await admin.auth().deleteUser(userId);
  console.log(`[firebase] User deleted: ${userId}`);
  return { deleted: true };
}

module.exports = { signUp, confirmSignUp, signIn, refreshTokens, resendCode, deleteUser };
