const { GoogleGenAI } = require("@google/genai");
const { withCircuitBreaker } = require("./circuitBreaker");
const { withTimeout } = require("./withTimeout");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "60000", 10); // 60s for text-only calls
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
 * Detect image format from base64 string.
 * Checks decoded magic bytes for reliable detection, with base64 prefix fallback.
 * Gemini requires the correct format — hardcoding "jpeg" fails for PNG images.
 */
function detectImageFormat(base64String) {
  // Try decoding the first few bytes for reliable magic-byte detection
  try {
    const header = Buffer.from(base64String.slice(0, 24), "base64");
    // PNG: 89 50 4E 47
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return "png";
    // JPEG: FF D8 FF
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return "jpeg";
    // WebP: RIFF....WEBP
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
        header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return "webp";
    // GIF: GIF8
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) return "gif";
    // BMP: BM
    if (header[0] === 0x42 && header[1] === 0x4D) return "bmp";
  } catch {
    // Fallback to base64 prefix matching
  }

  // Base64 prefix fallback (less reliable but still useful)
  if (base64String.startsWith("iVBOR")) return "png";
  if (base64String.startsWith("/9j/")) return "jpeg";
  if (base64String.startsWith("UklG")) return "webp";
  return "jpeg"; // final fallback
}

async function analyzeProduct(imageBase64, title, breadcrumbs) {
  const systemPrompt = `You are a product classification assistant for a virtual try-on shopping app.
Analyze the product image and information provided, then return a JSON response with the following structure:
{
  "category": "clothing" | "footwear" | "cosmetics" | "accessories" | "unsupported",
  "garmentClass": "UPPER_BODY" | "LOWER_BODY" | "FULL_BODY" | "FOOTWEAR" | null,
  "garmentSubClass": "LONG_SLEEVE_SHIRT" | "SHORT_SLEEVE_SHIRT" | "NO_SLEEVE_SHIRT" | "LONG_PANTS" | "SHORT_PANTS" | "LONG_DRESS" | "SHORT_DRESS" | "FULL_BODY_OUTFIT" | "SHOES" | "BOOTS" | null,
  "cosmeticType": "lipstick" | "eyeshadow" | "blush" | "foundation" | "eyeliner" | "mascara" | null,
  "accessoryType": "earrings" | "necklace" | "bracelet" | "ring" | "sunglasses" | null,
  "color": "the primary color of the product",
  "styleTips": ["tip1", "tip2", "tip3"]
}

Classification rules:
- Shirts, jackets, hoodies, blouses, tops, sweaters, coats, crop tops → category: "clothing", garmentClass: "UPPER_BODY"
- Pants, jeans, skirts, shorts, leggings → category: "clothing", garmentClass: "LOWER_BODY"
- Dresses, jumpsuits, overalls, rompers (SINGLE connected garment only) → category: "clothing", garmentClass: "FULL_BODY"
- Shoes, boots, sandals, sneakers, heels → category: "footwear", garmentClass: "FOOTWEAR"
- Lipstick, lip gloss, lip color → category: "cosmetics", cosmeticType: "lipstick"
- Eye shadow, eye palette → category: "cosmetics", cosmeticType: "eyeshadow"
- Blush, bronzer, highlighter → category: "cosmetics", cosmeticType: "blush"
- Foundation, concealer, powder, BB cream → category: "cosmetics", cosmeticType: "foundation"
- Eyeliner, eye pencil, kohl → category: "cosmetics", cosmeticType: "eyeliner"
- Mascara, lash product → category: "cosmetics", cosmeticType: "mascara"
- Earrings, ear studs, ear cuffs, hoops → category: "accessories", accessoryType: "earrings"
- Necklace, pendant, chain, choker → category: "accessories", accessoryType: "necklace"
- Bracelet, bangle, wrist chain → category: "accessories", accessoryType: "bracelet"
- Ring, finger ring, band → category: "accessories", accessoryType: "ring"
- Sunglasses, eyeglasses, glasses → category: "accessories", accessoryType: "sunglasses"
- Watches, bags, hats, scarves → category: "unsupported"
- Everything else → category: "unsupported"

CRITICAL classification rules — apply in this EXACT priority order:

RULE 1 — TITLE KEYWORDS OVERRIDE EVERYTHING:
- If the product TITLE contains "jumpsuit", "romper", "playsuit", "overalls", or "catsuit" → category: "clothing", garmentClass: "FULL_BODY", ALWAYS. No exceptions. Even if the image looks like two separate pieces.
- If the product TITLE contains "dress" or "gown" → category: "clothing", garmentClass: "FULL_BODY", ALWAYS.
- If the product TITLE contains "top", "shirt", "blouse", "crop top", "hoodie", "jacket", "sweater" → category: "clothing", garmentClass: "UPPER_BODY", even if the image shows matching pants.
- If the product TITLE contains "pants", "jeans", "skirt", "shorts", "leggings" → category: "clothing", garmentClass: "LOWER_BODY", even if the image shows a matching top.

RULE 2 — TWO-PIECE SETS (only if title is ambiguous):
- If the image shows a MATCHING SET (top + bottom sold together) and the title does NOT contain any of the keywords above, classify based on the most prominent piece in the image.
- FULL_BODY should ONLY be used for SINGLE connected garments — NOT for two separate pieces shown together — UNLESS the title says "jumpsuit", "romper", "dress", etc.

For styleTips, provide 2-3 short, helpful fashion tips about how to style or wear this product.

IMPORTANT: Return ONLY valid JSON, no additional text.`;

  const client = getClient();

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: `image/${detectImageFormat(imageBase64)}`,
            data: imageBase64,
          },
        },
        {
          text: `Product title: ${title}\nCategory path: ${breadcrumbs}\n\nAnalyze this product for virtual try-on classification. Return JSON only.`,
        },
      ],
    }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      maxOutputTokens: 512,
      temperature: 0.1,
    },
  }), GEMINI_TIMEOUT_MS, "analyzeProduct"));

  // Extract the text response
  const responseText = response.candidates[0].content.parts[0].text;

  // Parse JSON from response (handle potential markdown code blocks)
  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse Gemini response:", responseText);
    // Fallback: try to extract JSON object from response
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch (_) {}
    }
    // Last resort: return a basic classification based on title keywords
    console.warn("[classifier] analyzeProduct: falling back to title-based classification");
    return classifyByTitle(title);
  }
}

/**
 * Classify what the person is currently wearing in their photo.
 * Used to resolve clothing conflicts in virtual try-on.
 * Returns: { currentType: "FULL_BODY"|"UPPER_LOWER"|"OUTERWEAR", description: string }
 */
async function classifyOutfit(imageBase64) {
  const systemPrompt = `You are a fashion analysis assistant. Analyze what the person in the image is currently wearing and classify their outfit.

Return a JSON response with this structure:
{
  "currentType": "FULL_BODY" | "UPPER_LOWER" | "OUTERWEAR",
  "upperDescription": "description of upper body clothing or null",
  "lowerDescription": "description of lower body clothing or null",
  "fullDescription": "description of full body garment or null",
  "outerwearDescription": "description of outerwear or null"
}

Classification rules:
- FULL_BODY: Person is wearing a SINGLE PIECE garment that covers both upper and lower body. This includes: dresses, jumpsuits, rompers, playsuits, overalls, gowns, one-piece outfits, skort sets that are connected. IMPORTANT: If the top and bottom appear to be the SAME COLOR and SAME FABRIC/MATERIAL, it is very likely a single piece (dress, romper, playsuit) and should be classified as FULL_BODY.
- UPPER_LOWER: Person is wearing CLEARLY SEPARATE and DISTINCT top and bottom pieces that are DIFFERENT garments (e.g. a white shirt with blue jeans, a red blouse with a black skirt). The top and bottom must be visibly different items.
- OUTERWEAR: Person is wearing a coat, jacket, or blazer over other clothing

When in doubt between FULL_BODY and UPPER_LOWER, prefer FULL_BODY if the upper and lower pieces match in color/fabric.

For FULL_BODY: set fullDescription (e.g. "red floral dress", "black jumpsuit", "blue romper")
For UPPER_LOWER: set upperDescription (e.g. "white t-shirt") and lowerDescription (e.g. "blue jeans")
For OUTERWEAR: set outerwearDescription and also set what's underneath if visible

IMPORTANT: Return ONLY valid JSON, no additional text.`;

  const client = getClient();

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: `image/${detectImageFormat(imageBase64)}`,
            data: imageBase64,
          },
        },
        {
          text: "Analyze what this person is currently wearing. Classify the outfit type and describe each piece. Return JSON only.",
        },
      ],
    }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      maxOutputTokens: 256,
      temperature: 0.1,
    },
  }), GEMINI_TIMEOUT_MS, "classifyOutfit"));

  const responseText = response.candidates[0].content.parts[0].text;

  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse outfit classification:", responseText);
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }
    // Fallback: assume separate top+bottom (safest default)
    console.warn("[classifier] classifyOutfit: could not parse response, defaulting to UPPER_LOWER");
    return { currentType: "UPPER_LOWER", upperDescription: null, lowerDescription: null };
  }
}

/**
 * Detect if an image contains a person/model wearing the garment.
 * Used to decide if garment extraction is needed before try-on.
 */
async function hasPersonInImage(imageBase64) {
  const systemPrompt = `You are an image analysis assistant. Analyze the image and determine if it contains a person or human model wearing clothing.

Return a JSON response:
{
  "hasPerson": true | false,
  "garmentDescription": "brief description of the garment" | null
}

Rules:
- hasPerson: true if there is a visible person, human model, or mannequin wearing the garment
- hasPerson: false if the image shows ONLY a garment (flat lay, on hanger, product-only shot, no human body visible)
- garmentDescription: if hasPerson is true, describe the main garment (e.g. "blue denim jacket", "red floral dress")
- garmentDescription: null if hasPerson is false

IMPORTANT: Return ONLY valid JSON, no additional text.`;

  const client = getClient();

  const response = await withCircuitBreaker("gemini", () => withTimeout(client.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: `image/${detectImageFormat(imageBase64)}`,
            data: imageBase64,
          },
        },
        {
          text: "Does this image contain a person or model? Return JSON only.",
        },
      ],
    }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      maxOutputTokens: 256,
      temperature: 0.1,
    },
  }), GEMINI_TIMEOUT_MS, "hasPersonInImage"));

  const responseText = response.candidates[0].content.parts[0].text;

  let jsonStr = responseText;
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const objectMatch = responseText.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }
    return { hasPerson: false, garmentDescription: null };
  }
}

/**
 * Fallback classification based on product title keywords.
 * Used when Gemini fails to return valid JSON.
 */
function classifyByTitle(title) {
  const t = (title || "").toLowerCase();

  // Cosmetics
  const cosmeticPatterns = [
    { match: /lipstick|lip\s*(gloss|balm|color|stain|tint)/i, type: "lipstick" },
    { match: /eye\s*shadow|eye\s*palette/i, type: "eyeshadow" },
    { match: /blush|bronzer|highlighter/i, type: "blush" },
    { match: /foundation|concealer|powder|bb\s*cream/i, type: "foundation" },
    { match: /eyeliner|eye\s*pencil|kohl/i, type: "eyeliner" },
    { match: /mascara|lash/i, type: "mascara" },
  ];
  for (const p of cosmeticPatterns) {
    if (p.match.test(t)) {
      return { category: "cosmetics", cosmeticType: p.type, garmentClass: null, color: null, styleTips: [] };
    }
  }

  // Accessories
  const accessoryPatterns = [
    { match: /earring|ear\s*(stud|cuff|hoop)/i, type: "earrings" },
    { match: /necklace|pendant|chain|choker/i, type: "necklace" },
    { match: /bracelet|bangle/i, type: "bracelet" },
    { match: /\bring\b|finger\s*ring/i, type: "ring" },
    { match: /sunglasses|eyeglasses/i, type: "sunglasses" },
  ];
  for (const p of accessoryPatterns) {
    if (p.match.test(t)) {
      return { category: "accessories", accessoryType: p.type, garmentClass: null, color: null, styleTips: [] };
    }
  }

  // Clothing
  if (/jumpsuit|romper|playsuit|overalls|catsuit/i.test(t)) {
    return { category: "clothing", garmentClass: "FULL_BODY", color: null, styleTips: [] };
  }
  if (/dress|gown/i.test(t)) {
    return { category: "clothing", garmentClass: "FULL_BODY", color: null, styleTips: [] };
  }
  if (/pants|jeans|skirt|shorts|leggings/i.test(t)) {
    return { category: "clothing", garmentClass: "LOWER_BODY", color: null, styleTips: [] };
  }
  if (/shirt|blouse|top|hoodie|jacket|sweater|coat|vest/i.test(t)) {
    return { category: "clothing", garmentClass: "UPPER_BODY", color: null, styleTips: [] };
  }
  if (/shoe|boot|sandal|sneaker|heel|slipper/i.test(t)) {
    return { category: "footwear", garmentClass: "FOOTWEAR", color: null, styleTips: [] };
  }

  // Default: assume clothing upper body
  return { category: "clothing", garmentClass: "UPPER_BODY", color: null, styleTips: [] };
}

module.exports = { analyzeProduct, classifyOutfit, hasPersonInImage };
