const { Firestore } = require('@google-cloud/firestore');

// Initialize with service account (local dev) or ADC (Cloud Run)
const firestoreOpts = {
  projectId: process.env.GCP_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID || 'gemini-tryonme-everything',
};
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  firestoreOpts.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
}
const db = new Firestore(firestoreOpts);

// --- Profiles ---

async function getProfile(userId) {
  const doc = await db.collection('userProfiles').doc(userId).get();
  return doc.exists ? doc.data() : null;
}

async function putProfile(userId, data) {
  const item = {
    userId,
    ...data,
    updatedAt: new Date().toISOString(),
  };
  if (!data.createdAt) {
    item.createdAt = new Date().toISOString();
  }
  await db.collection('userProfiles').doc(userId).set(item);
  return item;
}

async function deleteProfile(userId) {
  await db.collection('userProfiles').doc(userId).delete();
  return { removed: true };
}

// --- Favorites ---

async function getFavorites(userId) {
  const snapshot = await db.collection('userProfiles').doc(userId)
    .collection('favorites').get();
  return snapshot.docs.map(doc => {
    const fav = doc.data();
    return {
      ...fav,
      productId: fav.productId || fav.asin,
      retailer: fav.retailer || "amazon",
    };
  });
}

async function addFavorite(userId, favoriteData) {
  const productId = favoriteData.productId || favoriteData.asin;
  const retailer = favoriteData.retailer || 'amazon';
  const docId = `${retailer}_${productId}`;
  const item = {
    userId,
    productId,
    retailer,
    productTitle: favoriteData.productTitle,
    productImage: favoriteData.productImage,
    category: favoriteData.category || "",
    garmentClass: favoriteData.garmentClass || "",
    tryOnResultKey: favoriteData.tryOnResultKey || "",
    outfitId: favoriteData.outfitId || "",
    savedAt: new Date().toISOString(),
  };
  await db.collection('userProfiles').doc(userId)
    .collection('favorites').doc(docId).set(item);
  return item;
}

async function removeFavorite(userId, productId) {
  await db.collection('userProfiles').doc(userId)
    .collection('favorites').doc(productId).delete();
  return { removed: true };
}

async function isFavorite(userId, productId) {
  const doc = await db.collection('userProfiles').doc(userId)
    .collection('favorites').doc(productId).get();
  return doc.exists;
}

// --- Videos ---

async function getUserVideos(userId) {
  const snapshot = await db.collection('userProfiles').doc(userId)
    .collection('videos').get();
  return snapshot.docs.map(doc => doc.data());
}

async function saveVideoRecord(userId, videoData) {
  const item = {
    userId,
    videoId: videoData.videoId,
    videoKey: videoData.videoKey,
    productId: videoData.productId || videoData.asin || "",
    retailer: videoData.retailer || "amazon",
    productTitle: videoData.productTitle || "",
    productImage: videoData.productImage || "",
    savedAt: new Date().toISOString(),
  };
  await db.collection('userProfiles').doc(userId)
    .collection('videos').doc(videoData.videoId).set(item);
  return item;
}

async function removeVideo(userId, videoId) {
  await db.collection('userProfiles').doc(userId)
    .collection('videos').doc(videoId).delete();
  return { removed: true };
}

module.exports = { getProfile, putProfile, deleteProfile, getFavorites, addFavorite, removeFavorite, isFavorite, getUserVideos, saveVideoRecord, removeVideo };
