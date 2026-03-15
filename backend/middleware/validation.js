// Base64 character set regex (allows standard base64 + padding)
const BASE64_REGEX = /^[A-Za-z0-9+/\n\r]+=*$/;

/**
 * Validate that a string is legitimate base64-encoded image data.
 * Checks format, decodability, and size.
 * @param {string} data - The base64 string to validate
 * @param {number} maxBytes - Maximum decoded size in bytes (default 15MB)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateBase64Image(data, maxBytes = 15 * 1024 * 1024) {
  if (typeof data !== "string" || data.length === 0) {
    return { valid: false, error: "Image data must be a non-empty string" };
  }

  // Strip optional data URI prefix
  let raw = data;
  if (raw.startsWith("data:")) {
    const commaIdx = raw.indexOf(",");
    if (commaIdx === -1) return { valid: false, error: "Malformed data URI" };
    raw = raw.slice(commaIdx + 1);
  }

  // Quick length check before regex (approximate decoded size: base64 is ~4/3 of original)
  const estimatedBytes = Math.ceil(raw.length * 3 / 4);
  if (estimatedBytes > maxBytes) {
    return { valid: false, error: `Image too large. Maximum ${Math.round(maxBytes / 1024 / 1024)}MB per image.` };
  }

  // Validate base64 characters
  if (!BASE64_REGEX.test(raw)) {
    return { valid: false, error: "Invalid base64 encoding" };
  }

  // Verify it actually decodes
  try {
    Buffer.from(raw, "base64");
  } catch {
    return { valid: false, error: "Failed to decode base64 image" };
  }

  return { valid: true };
}

function validateImagePayload(req, res, next) {
  const contentLength = parseInt(req.headers["content-length"] || "0");
  if (contentLength > 50 * 1024 * 1024) {  // 50MB limit
    return res.status(413).json({ error: "Payload too large. Maximum 50MB." });
  }
  next();
}

module.exports = { validateImagePayload, validateBase64Image };
