const { Storage } = require('@google-cloud/storage');

// Initialize with service account (local dev) or ADC (Cloud Run)
const storageOpts = {};
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  storageOpts.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
}
const storage = new Storage(storageOpts);
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'nova-tryonme-users';
const bucket = storage.bucket(BUCKET_NAME);

async function uploadFile(key, buffer, contentType) {
  const file = bucket.file(key);
  await file.save(buffer, { contentType, resumable: false });
}

async function downloadFile(key) {
  const file = bucket.file(key);
  const [buffer] = await file.download();
  return buffer;
}

async function downloadFileBase64(key) {
  const buffer = await downloadFile(key);
  return buffer.toString('base64');
}

async function deleteAllWithPrefix(prefix) {
  await bucket.deleteFiles({ prefix, force: true });
}

async function getSignedReadUrl(key, expiresInSeconds = 3600) {
  const file = bucket.file(key);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresInSeconds * 1000,
  });
  return url;
}

module.exports = { uploadFile, downloadFile, downloadFileBase64, deleteAllWithPrefix, getSignedReadUrl };
