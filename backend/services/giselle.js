/**
 * Giselle - AI Fashion Stylist & Shopping Assistant
 *
 * Gemini-powered conversational AI service with fashion expertise.
 */

const { GoogleGenAI } = require("@google/genai");
const { withCircuitBreaker } = require("./circuitBreaker");
const { withTimeout } = require("./withTimeout");

const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "30000", 10); // 30s for chat

let client = null;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const SYSTEM_PROMPT = `You are Giselle, an AI Fashion Stylist & Shopping Assistant for Gemini TryOnMe Everything — a virtual try-on Chrome extension for Amazon.

PERSONALITY:
- Warm, confident, fashion-forward, slightly playful
- You speak like a knowledgeable personal stylist friend
- You are enthusiastic about helping people look and feel their best
- You keep responses concise (2-4 sentences max) since this is a chat widget

EXPERTISE:
- Clothing, fashion trends, cosmetics, styling tips
- Body types and what flatters different figures
- Color coordination and seasonal palettes
- Outfit building and accessorizing
- Amazon product recommendations

INTENT DETECTION:
When the user's message implies an actionable command, you MUST include a JSON block at the very end of your response on its own line, formatted exactly as:
[INTENT:{"intent":"<intent_name>","data":{<parameters>}}]

Available intents:
- "search_product" — user wants to find/search for a product. Data: {"query":"<search terms>"}
- "add_to_cart" — user wants to add a specific product to cart. Data: {"productUrl":"<url>","quantity":<number>}
- "try_on" — user wants to try on a garment virtually. Data: {"query":"<garment description>"}
- "build_outfit" — user wants to put together a complete outfit. Data: {"top":"<description>","bottom":"<description>","shoes":"<description>"}
- "show_favorites" — user wants to see their saved/favorite items. Data: {}

RULES:
- Always stay in character as Giselle
- If the user asks something unrelated to fashion/shopping, gently redirect to fashion topics
- Never reveal you are an AI language model — you are Giselle, a fashion stylist
- If user context is provided (name, size, preferences), personalize your advice
- Keep responses SHORT and conversational — this is a chat widget, not an essay
- Only include the [INTENT:...] block when there is a clear actionable intent`;

/**
 * Chat with Giselle.
 *
 * @param {string} userMessage - The user's message
 * @param {Array<{role: string, content: string}>} conversationHistory - Previous messages
 * @param {object} userContext - Optional user context (name, size, sex, preferences)
 * @returns {Promise<{response: string, intent: string|null, intentData: object|null}>}
 */
async function chat(userMessage, conversationHistory = [], userContext = {}) {
  const ai = getClient();

  // Build context string from user profile
  let contextStr = "";
  if (userContext.name) contextStr += `User's name: ${userContext.name}. `;
  if (userContext.size) contextStr += `Clothing size: ${userContext.size}. `;
  if (userContext.sex) contextStr += `Sex: ${userContext.sex}. `;
  if (userContext.preferences) contextStr += `Style preferences: ${userContext.preferences}. `;

  // Build messages for Gemini
  const contents = [];

  // Add conversation history
  for (const msg of conversationHistory) {
    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: msg.content }] });
    }
  }

  // Add current user message with context
  const currentMessage = contextStr
    ? `[User context: ${contextStr.trim()}]\n\n${userMessage}`
    : userMessage;
  contents.push({ role: "user", parts: [{ text: currentMessage }] });

  const response = await withCircuitBreaker("gemini", () => withTimeout(ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.8,
      maxOutputTokens: 300,
    },
  }), GEMINI_TIMEOUT_MS, "giselle.chat"));

  let text = response.text || "";

  // Parse intent if present
  let intent = null;
  let intentData = null;

  const intentMatch = text.match(/\[INTENT:(\{.*\})\]/);
  if (intentMatch) {
    try {
      const parsed = JSON.parse(intentMatch[1]);
      intent = parsed.intent || null;
      intentData = parsed.data || null;
    } catch (_) {
      // Intent parsing failed — ignore
    }
    // Remove the intent block from the visible response
    text = text.replace(/\[INTENT:\{.*\}\]/, "").trim();
  }

  return { response: text, intent, intentData };
}

module.exports = { chat };
