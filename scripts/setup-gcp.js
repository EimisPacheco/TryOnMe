/**
 * NovaTryOnMe - GCP Resource Setup Script
 *
 * Creates Cloud Storage bucket and verifies Firestore/Firebase Auth are ready.
 * Run once: node scripts/setup-gcp.js
 *
 * Prerequisites:
 *   1. Service account JSON at project root: erica-bot-service-account.json
 *   2. Firebase Auth enabled in Firebase Console for this project
 *   3. Firestore enabled (Native mode) in GCP Console
 */

const path = require("path");

// Load dotenv from backend
require(path.join(__dirname, "..", "backend", "node_modules", "dotenv")).config({
  path: path.join(__dirname, "..", "backend", ".env"),
});

const { Storage } = require(path.join(__dirname, "..", "backend", "node_modules", "@google-cloud/storage"));
const { Firestore } = require(path.join(__dirname, "..", "backend", "node_modules", "@google-cloud/firestore"));
const admin = require(path.join(__dirname, "..", "backend", "node_modules", "firebase-admin"));

const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, "..", "erica-bot-service-account.json");
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || "nova-tryonme-users";

async function createStorageBucket() {
  console.log("\n=== Cloud Storage ===");
  const storage = new Storage({ keyFilename: SERVICE_ACCOUNT_PATH });

  try {
    const [exists] = await storage.bucket(BUCKET_NAME).exists();
    if (exists) {
      console.log(`✓ Bucket "${BUCKET_NAME}" already exists`);
    } else {
      await storage.createBucket(BUCKET_NAME, { location: "US" });
      console.log(`✓ Created bucket "${BUCKET_NAME}"`);
    }
  } catch (err) {
    console.error(`✗ Storage error: ${err.message}`);
    console.log("  → Make sure the service account has Storage Admin role");
  }
}

async function checkFirestore() {
  console.log("\n=== Firestore ===");
  const db = new Firestore({
    keyFilename: SERVICE_ACCOUNT_PATH,
    projectId: GCP_PROJECT_ID,
    databaseId: 'gemini-tryonme-everything',
  });

  try {
    // Try a simple read to verify Firestore is accessible
    await db.collection("_healthcheck").doc("test").get();
    console.log("✓ Firestore is accessible");
    console.log("  Collections will be auto-created on first write:");
    console.log("    - userProfiles (profiles)");
    console.log("    - userProfiles/{userId}/favorites (subcollection)");
    console.log("    - userProfiles/{userId}/videos (subcollection)");
  } catch (err) {
    console.error(`✗ Firestore error: ${err.message}`);
    console.log("  → Enable Firestore (Native mode) in GCP Console:");
    console.log("    https://console.cloud.google.com/firestore");
  }
}

async function checkFirebaseAuth() {
  console.log("\n=== Firebase Auth ===");
  try {
    const serviceAccount = require(SERVICE_ACCOUNT_PATH);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: GCP_PROJECT_ID,
      });
    }

    // Try listing users (limit 1) to verify Firebase Auth is set up
    await admin.auth().listUsers(1);
    console.log("✓ Firebase Auth is accessible");
  } catch (err) {
    console.error(`✗ Firebase Auth error: ${err.message}`);
    console.log("  → Set up Firebase Auth:");
    console.log("    1. Go to https://console.firebase.google.com/");
    console.log("    2. Add/select your GCP project");
    console.log("    3. Enable Authentication → Email/Password");
    console.log("    4. Get Web API Key from Project Settings");
  }
}

async function main() {
  console.log("NovaTryOnMe — GCP Resource Setup");
  console.log("================================");
  console.log(`Project: ${GCP_PROJECT_ID || "(not set — set GCP_PROJECT_ID)"}`);
  console.log(`Service Account: ${SERVICE_ACCOUNT_PATH}`);
  console.log(`Bucket: ${BUCKET_NAME}`);

  await createStorageBucket();
  await checkFirestore();
  await checkFirebaseAuth();

  console.log("\n================================");
  console.log("Setup complete! Make sure your .env file has:");
  console.log(`  GOOGLE_APPLICATION_CREDENTIALS=${SERVICE_ACCOUNT_PATH}`);
  console.log(`  GCP_PROJECT_ID=${GCP_PROJECT_ID || "<your-project-id>"}`);
  console.log(`  GCS_BUCKET_NAME=${BUCKET_NAME}`);
  console.log("  FIREBASE_API_KEY=<from Firebase Console → Project Settings → Web API Key>");
  console.log("  GEMINI_API_KEY=<your Gemini API key>");
}

main().catch(console.error);
