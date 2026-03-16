/**
 * Giselle Live - Real-time voice AI Fashion Stylist
 *
 * Manages Gemini Live API sessions for bidirectional audio streaming.
 * Each client WebSocket gets its own Gemini Live session.
 */

const { GoogleGenAI, Modality } = require("@google/genai");

let client = null;
function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

// Active sessions: sessionId → { session, clientWs, heartbeat, resumptionHandle, userContext }
const sessions = new Map();

const SYSTEM_PROMPT = `You are Giselle, an AI Fashion Stylist & Shopping Assistant for Gemini TryOnMe Everything — a virtual try-on Chrome extension for Amazon.

PERSONALITY:
- Warm, confident, fashion-forward, slightly playful
- You speak like a knowledgeable personal stylist friend
- You are enthusiastic about helping people look and feel their best
- You keep responses concise (2-4 sentences max) since this is a voice conversation

EXPERTISE:
- Clothing, fashion trends, cosmetics, styling tips
- Body types and what flatters different figures
- Color coordination and seasonal palettes
- Outfit building and accessorizing
- Amazon product recommendations

RULES:
- Always stay in character as Giselle
- If the user asks something unrelated to fashion/shopping, gently redirect to fashion topics
- Never reveal you are an AI language model — you are Giselle, a fashion stylist
- If user context is provided (name, size, preferences), personalize your advice
- Keep responses SHORT and conversational — this is a voice chat, not an essay
- Use the available tools when the user wants to search, try on, build outfits, or manage favorites/videos

OUTFIT BUILDER FLOW — CRITICAL, FOLLOW EXACTLY:
- The outfit builder has 6 categories: top, bottom, shoes, necklace, earrings, bracelet
- The first 3 (top, bottom, shoes) are the main items. The last 3 (necklace, earrings, bracelet) are optional accessories
- NEVER call build_outfit immediately. ALWAYS follow this multi-step flow:
  STEP 1: Collect whatever items the user mentions
  STEP 2: List back what you have so far and ASK about the remaining categories they haven't mentioned
  STEP 3: WAIT for the user to respond — they may add more items or say they're done
  STEP 4: ONLY after the user explicitly confirms (e.g. "that's it", "I'm done", "go ahead", "build it", "no more") → THEN call build_outfit
- Example conversation:
  User: "Build me an outfit with a black top and green skirt"
  You: "Great choices! I have a black top and green skirt. What about shoes? And would you like any accessories — a necklace, earrings, or bracelet?"
  User: "Green sneakers and that's it"
  You: [NOW call build_outfit with top="black top", bottom="green skirt", shoes="green sneakers"]
- DO NOT call build_outfit until the user says they are done. This is mandatory — even if they gave you 3 items, ASK about the remaining categories first
- CRITICAL: When you call build_outfit, you MUST pass EVERY item as a named parameter in the function call:
  * If user mentioned "black earrings" → include earrings="black earrings" in the tool call
  * If user mentioned "gold necklace" → include necklace="gold necklace" in the tool call
  * If user mentioned "silver bracelet" → include bracelet="silver bracelet" in the tool call
  * Include ALL items from the ENTIRE conversation, not just the last message
  * NEVER omit an item that was mentioned — even if it was mentioned several messages ago
  * Example: if user said top="blue shirt", bottom="black skirt", shoes="sneakers", earrings="white earrings", bracelet="white bracelet" — you MUST call build_outfit(top="blue shirt", bottom="black skirt", shoes="sneakers", earrings="white earrings", bracelet="white bracelet")

VISION & RECOMMENDATIONS:
- You can SEE images sent to you (search result screenshots, user photos)
- When the user asks "which one should I try?", "what do you recommend?", "what looks best on me?", or similar, use recommend_items
- After receiving the images, analyze the user's skin tone, body type, and the product colors/styles
- Give personalized recommendations referencing SPECIFIC item numbers (e.g. "I'd recommend item 3 and item 7")
- Explain WHY each item suits them — mention skin tone, color harmony, body type, or style
- Keep recommendations concise (2-3 top picks with brief reasoning)

SAVING & VIDEOS:
- When the user asks to save the current try-on result to favorites, use save_to_favorites
- When the user asks to save or download a video, use save_video
- When the user asks to see their saved videos, use show_videos
- When the user asks to see their favorites, use show_favorites`;

const GISELLE_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "search_product",
        description: "Search for a product on the shopping site. Use when user wants to find or browse products.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search terms for the product" },
          },
          required: ["query"],
        },
      },
      {
        name: "add_to_cart",
        description: "Add a product to the shopping cart.",
        parameters: {
          type: "OBJECT",
          properties: {
            productUrl: { type: "STRING", description: "URL of the product to add" },
            quantity: { type: "NUMBER", description: "Number of items to add" },
          },
          required: ["productUrl"],
        },
      },
      {
        name: "try_on",
        description: "Virtually try on a garment. Use when user wants to see how clothing looks on them. If smart search results are already displayed and the user refers to an item by number (e.g. 'try on item 3', 'try on number 2'), pass the itemNumber. Otherwise pass a query to search first.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Description of the garment to try on" },
            itemNumber: { type: "NUMBER", description: "The item number from the displayed smart search results (e.g. 1, 2, 3). Use this when the user refers to an item by its number in the search results." },
          },
        },
      },
      {
        name: "build_outfit",
        description: "Build a complete outfit. IMPORTANT: Do NOT call this tool until the user has explicitly confirmed they are done adding items. You MUST first ask about any categories they haven't mentioned (top, bottom, shoes, necklace, earrings, bracelet) and wait for confirmation. When calling, include ALL items mentioned across the entire conversation — do NOT omit items the user mentioned earlier.",
        parameters: {
          type: "OBJECT",
          properties: {
            top: { type: "STRING", description: "Description of the top garment" },
            bottom: { type: "STRING", description: "Description of the bottom garment" },
            shoes: { type: "STRING", description: "Description of the shoes" },
            necklace: { type: "STRING", description: "Description of the necklace (optional)" },
            earrings: { type: "STRING", description: "Description of the earrings (optional)" },
            bracelet: { type: "STRING", description: "Description of the bracelet (optional)" },
          },
        },
      },
      {
        name: "show_favorites",
        description: "Show the user their saved/favorite items.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "save_to_favorites",
        description: "Save the current try-on result to the user's favorites. Use when the user says to save, heart, or favorite the current item.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "save_video",
        description: "Save the currently displayed video. Use when the user asks to save or download the video they are viewing.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "show_videos",
        description: "Show the user their saved videos.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
      {
        name: "recommend_items",
        description: "Visually analyze the search results and recommend the best items for the user based on their skin tone, body type, and style. Use when the user asks 'which one should I try?', 'what do you recommend?', 'what looks best on me?', or similar. This sends the user's photo and search results screenshot for visual analysis.",
        parameters: {
          type: "OBJECT",
          properties: {},
        },
      },
    ],
  },
];

/**
 * Build system instruction with user context.
 */
function buildSystemInstruction(userContext) {
  let instruction = SYSTEM_PROMPT;
  if (userContext) {
    const parts = [];
    if (userContext.name) parts.push(`User's name: ${userContext.name}`);
    if (userContext.size) parts.push(`Clothing size: ${userContext.size}`);
    if (userContext.shoesSize) parts.push(`Shoes size: ${userContext.shoesSize}`);
    if (userContext.sex) parts.push(`Sex: ${userContext.sex}`);
    if (userContext.preferences) parts.push(`Style preferences: ${userContext.preferences}`);
    if (parts.length > 0) {
      instruction += `\n\nUSER CONTEXT:\n${parts.join("\n")}`;
    }
    // Language instruction
    if (userContext.language && userContext.language !== "en") {
      const langMap = {
        es: "Spanish", fr: "French", de: "German", it: "Italian",
        pt: "Portuguese", ja: "Japanese", zh: "Chinese", ko: "Korean",
        hi: "Hindi", ar: "Arabic",
      };
      const langName = langMap[userContext.language] || userContext.language;
      instruction += `\n\nLANGUAGE: You MUST speak in ${langName}. All your responses must be in ${langName}. Do NOT speak in English unless the user switches to English.`;
    }
  }
  return instruction;
}

/**
 * Send a JSON message to client WebSocket if open.
 */
function sendToClient(clientWs, msg) {
  if (clientWs.readyState === 1) { // WebSocket.OPEN
    clientWs.send(JSON.stringify(msg));
  }
}

/**
 * Create a new Gemini Live session for a client.
 * If resumptionHandle is provided, resumes the previous session with context intact.
 */
async function createSession(sessionId, clientWs, userContext, resumptionHandle) {
  const ai = getClient();

  const isResume = !!resumptionHandle;
  console.log(`[giselle-live] ${isResume ? "Resuming" : "Creating"} session ${sessionId}`);

  const session = await ai.live.connect({
    model: "gemini-2.5-flash-native-audio-latest",
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: buildSystemInstruction(userContext),
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Aoede" },
        },
      },
      tools: GISELLE_TOOLS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
    },
    callbacks: {
      onopen: () => {
        console.log(`[giselle-live] Session ${sessionId} connected to Gemini${isResume ? " (resumed)" : ""}`);
        sendToClient(clientWs, { type: "setup_complete" });
      },
      onmessage: (msg) => {
        handleServerMessage(sessionId, clientWs, msg);
      },
      onerror: (e) => {
        console.error(`[giselle-live] Session ${sessionId} error:`, e.message || e.error || e);
        sendToClient(clientWs, { type: "error", message: "Voice session error" });
      },
      onclose: (e) => {
        console.log(`[giselle-live] Session ${sessionId} Gemini closed — code: ${e?.code}, reason: ${e?.reason || "(none)"}`);
        sendToClient(clientWs, { type: "session_closed" });
        // Don't cleanup — keep entry so resumptionHandle + userContext survive for reconnect
      },
    },
  });

  // Heartbeat to keep Cloud Run WS alive
  const heartbeat = setInterval(() => {
    if (clientWs.readyState === 1) {
      clientWs.ping();
    } else {
      cleanup(sessionId);
    }
  }, 30000);

  const existing = sessions.get(sessionId);
  sessions.set(sessionId, {
    session,
    clientWs,
    heartbeat,
    resumptionHandle: existing?.resumptionHandle || null,
    userContext,
  });
  return session;
}

/**
 * Handle messages from Gemini Live API.
 */
function handleServerMessage(sessionId, clientWs, msg) {
  // Audio data from model
  if (msg.serverContent?.modelTurn?.parts) {
    for (const part of msg.serverContent.modelTurn.parts) {
      if (part.inlineData) {
        sendToClient(clientWs, {
          type: "audio",
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType,
        });
      }
      if (part.text) {
        sendToClient(clientWs, {
          type: "text_response",
          text: part.text,
        });
      }
    }
  }

  // Turn complete
  if (msg.serverContent?.turnComplete) {
    sendToClient(clientWs, { type: "turn_complete" });
  }

  // Barge-in / interrupted
  if (msg.serverContent?.interrupted) {
    sendToClient(clientWs, { type: "interrupted" });
  }

  // Input transcription (what the user said)
  if (msg.serverContent?.inputTranscription?.text) {
    sendToClient(clientWs, {
      type: "input_transcription",
      text: msg.serverContent.inputTranscription.text,
    });
  }

  // Output transcription (what the model said)
  if (msg.serverContent?.outputTranscription?.text) {
    sendToClient(clientWs, {
      type: "output_transcription",
      text: msg.serverContent.outputTranscription.text,
    });
  }

  // Tool calls (intents)
  if (msg.toolCall?.functionCalls) {
    sendToClient(clientWs, {
      type: "tool_call",
      functionCalls: msg.toolCall.functionCalls,
    });
  }

  // Tool call cancellation
  if (msg.toolCallCancellation?.ids) {
    sendToClient(clientWs, {
      type: "tool_call_cancellation",
      ids: msg.toolCallCancellation.ids,
    });
  }

  // Session resumption update — store the handle for reconnection
  if (msg.sessionResumptionUpdate) {
    if (msg.sessionResumptionUpdate.resumable && msg.sessionResumptionUpdate.newHandle) {
      const entry = sessions.get(sessionId);
      if (entry) {
        entry.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
        console.log(`[giselle-live] Session ${sessionId} got resumption handle`);
      }
    }
  }

  // Server going away — include resumption handle so client can reconnect with context
  if (msg.goAway) {
    const entry = sessions.get(sessionId);
    sendToClient(clientWs, {
      type: "go_away",
      timeLeft: msg.goAway.timeLeft,
      resumptionHandle: entry?.resumptionHandle || null,
    });
  }
}

/**
 * Send audio data to Gemini Live session.
 */
function sendAudio(sessionId, audioBase64) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  entry.session.sendRealtimeInput({
    audio: {
      data: audioBase64,
      mimeType: "audio/pcm;rate=16000",
    },
  });
}

/**
 * Send an image to Gemini Live session with optional context text.
 * Used for vision — sending screenshots and user photos so Giselle can "see" products.
 */
function sendImage(sessionId, imageBase64, mimeType, contextText) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  const parts = [];
  if (imageBase64) {
    parts.push({ inlineData: { data: imageBase64, mimeType: mimeType || "image/jpeg" } });
  }
  if (contextText) {
    parts.push({ text: contextText });
  }
  if (parts.length === 0) return;

  entry.session.sendClientContent({
    turns: [{ role: "user", parts }],
    turnComplete: false, // don't end the turn — more images or audio may follow
  });
  console.log(`[giselle-live] Sent image to session ${sessionId} (${contextText ? contextText.substring(0, 50) + '...' : 'no context'})`);
}

/**
 * Send text to Gemini Live session.
 */
function sendText(sessionId, text) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  entry.session.sendClientContent({
    turns: [{ role: "user", parts: [{ text }] }],
    turnComplete: true,
  });
}

/**
 * Send tool response back to Gemini.
 */
function sendToolResponse(sessionId, functionResponses) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  entry.session.sendToolResponse({ functionResponses });
}

/**
 * Signal end of audio stream.
 */
function sendAudioEnd(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  entry.session.sendRealtimeInput({ audioStreamEnd: true });
}

/**
 * Close and clean up a session.
 */
function closeSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  try {
    entry.session.close();
  } catch (e) {
    console.warn(`[giselle-live] Error closing session ${sessionId}:`, e.message);
  }
  cleanup(sessionId);
}

/**
 * Internal cleanup.
 */
function cleanup(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  if (entry.heartbeat) clearInterval(entry.heartbeat);
  sessions.delete(sessionId);
  console.log(`[giselle-live] Session ${sessionId} cleaned up. Active sessions: ${sessions.size}`);
}

module.exports = {
  createSession,
  sendAudio,
  sendImage,
  sendText,
  sendToolResponse,
  sendAudioEnd,
  closeSession,
};
