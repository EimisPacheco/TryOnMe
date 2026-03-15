const { GoogleGenAI } = require("@google/genai");
const { withCircuitBreaker } = require("./circuitBreaker");
const { withTimeout } = require("./withTimeout");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Detect image format from base64 string using magic bytes.
 * Gemini requires correct mimeType — hardcoding "jpeg" fails for WebP/PNG images.
 */
function detectImageFormat(base64String) {
  try {
    const header = Buffer.from(base64String.slice(0, 24), "base64");
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return "png";
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return "jpeg";
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
        header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return "webp";
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) return "gif";
  } catch {}
  if (base64String.startsWith("iVBOR")) return "png";
  if (base64String.startsWith("/9j/")) return "jpeg";
  if (base64String.startsWith("UklG")) return "webp";
  return "jpeg";
}

function getMimeType(base64) {
  return `image/${detectImageFormat(base64)}`;
}
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "120000", 10);
let genaiClient = null;

function getClient() {
  if (!genaiClient) {
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in environment variables");
    }
    genaiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return genaiClient;
}

/**
 * Background removal using Gemini 2.5 Flash Image
 */
async function removeBackground(imageBase64) {
  console.log("[geminiCanvas] removeBackground - processing");

  const client = getClient();

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-2.5-flash-preview-04-17",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Remove the background from this image completely. Keep ONLY the main subject (person or garment). Place the subject on a clean, plain white background. Preserve the subject exactly as-is — same colors, details, proportions. Output only the resulting image.",
          },
          {
            inlineData: {
              mimeType: getMimeType(imageBase64),
              data: imageBase64,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  }), GEMINI_TIMEOUT_MS, "removeBackground"));

  const candidates = response.candidates || [];
  if (!candidates.length) {
    throw new Error("No response from Gemini for background removal");
  }

  const parts = candidates[0].content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      console.log("[geminiCanvas] removeBackground - success");
      return part.inlineData.data;
    }
  }

  throw new Error("No image in Gemini background removal response");
}

/**
 * Inpainting using Gemini 2.5 Flash Image
 * Used for cosmetics try-on - applies makeup to specific facial regions
 */
async function inpaint(sourceImageBase64, maskPrompt, textPrompt) {
  console.log(`[geminiCanvas] inpaint - maskPrompt: "${maskPrompt}", textPrompt: "${textPrompt}"`);

  const client = getClient();

  const prompt = `You are a professional photo editor specializing in cosmetics and makeup application.

Edit this photo by modifying ONLY the following area: ${maskPrompt}

Apply the following change to that area: ${textPrompt}

CRITICAL RULES:
- Modify ONLY the specified area (${maskPrompt}). Do NOT change anything else in the image.
- Keep the person's face, skin, hair, eyes, and all other features EXACTLY the same.
- The result must look photorealistic and natural, as if the makeup was actually applied.
- Blend the edit seamlessly with the surrounding skin/features.
- Preserve the exact same lighting, angle, and image quality.
- Output only the resulting image.`;

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-2.5-flash-preview-04-17",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
          {
            inlineData: {
              mimeType: getMimeType(sourceImageBase64),
              data: sourceImageBase64,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  }), GEMINI_TIMEOUT_MS, "inpaint"));

  const candidates = response.candidates || [];
  if (!candidates.length) {
    // Check for safety/block reasons
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason) {
      console.error(`[geminiCanvas] inpaint - blocked by safety: ${blockReason}`);
      throw new Error(`Cosmetic try-on blocked by content safety filter: ${blockReason}`);
    }
    throw new Error("No response from Gemini for inpainting");
  }

  // Check finish reason
  const finishReason = candidates[0].finishReason;
  if (finishReason === "SAFETY") {
    console.error(`[geminiCanvas] inpaint - response blocked by safety filter`);
    throw new Error("Cosmetic try-on blocked by content safety filter");
  }

  const parts = candidates[0].content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      console.log(`[geminiCanvas] inpaint - success, got image`);
      return part.inlineData.data;
    }
  }

  // Log what the model returned instead of an image
  const textParts = parts.filter(p => p.text).map(p => p.text).join(" ");
  console.error(`[geminiCanvas] inpaint - no image in response. finishReason: ${finishReason}, text: ${textParts.substring(0, 200)}`);
  throw new Error(`Cosmetic try-on failed: model returned text instead of image. ${textParts.substring(0, 100)}`);
}

/**
 * Apply an accessory from a product image onto a person's photo.
 * Uses Gemini with two input images: the person photo and the product image.
 */
async function applyAccessory(personImageBase64, productImageBase64, accessoryType) {
  console.log(`[geminiCanvas] applyAccessory - type: "${accessoryType}"`);

  const client = getClient();

  const PLACEMENT_HINTS = {
    earrings: "on both ears, replacing any existing earrings",
    necklace: "around the neck/chest area, over clothing",
    bracelet: "on the wrist, visible on one or both wrists",
    ring: "on a finger of the hand",
    sunglasses: "on the face, resting on the nose bridge and covering the eyes",
  };

  const placement = PLACEMENT_HINTS[accessoryType] || "in the appropriate body location";

  const prompt = `You are a professional photo editor specializing in jewelry and accessories virtual try-on.

TASK: Place the accessory shown in the SECOND image onto the person in the FIRST image.

Accessory type: ${accessoryType}
Placement: ${placement}

CRITICAL RULES:
- Study the accessory in the second image carefully — replicate its EXACT design, material, color, gemstones, and proportions.
- Place it naturally ${placement}.
- Match the lighting, shadows, and reflections to the person's photo.
- Keep the person's face, body, clothing, and all other features EXACTLY the same.
- The result must look photorealistic, as if the person is actually wearing the accessory.
- Scale the accessory appropriately to the person's body proportions.
- Output only the resulting image.`;

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-2.5-flash-preview-04-17",
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: getMimeType(personImageBase64),
              data: personImageBase64,
            },
          },
          {
            inlineData: {
              mimeType: getMimeType(productImageBase64),
              data: productImageBase64,
            },
          },
        ],
      },
    ],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  }), GEMINI_TIMEOUT_MS, "applyAccessory"));

  const candidates = response.candidates || [];
  if (!candidates.length) {
    throw new Error("No response from Gemini for accessory try-on");
  }

  const parts = candidates[0].content?.parts || [];
  for (const part of parts) {
    if (part.inlineData) {
      console.log(`[geminiCanvas] applyAccessory - success`);
      return part.inlineData.data;
    }
  }

  throw new Error("No image in Gemini accessory try-on response");
}

module.exports = { inpaint, removeBackground, applyAccessory };
