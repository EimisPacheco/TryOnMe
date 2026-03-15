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

// Active sessions: sessionId → { session, clientWs, heartbeat }
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
- Use the available tools when the user wants to search, try on, build outfits, or manage favorites`;

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
        description: "Virtually try on a garment. Use when user wants to see how clothing looks on them.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Description of the garment to try on" },
          },
          required: ["query"],
        },
      },
      {
        name: "build_outfit",
        description: "Build a complete outfit with top, bottom, and shoes.",
        parameters: {
          type: "OBJECT",
          properties: {
            top: { type: "STRING", description: "Description of the top" },
            bottom: { type: "STRING", description: "Description of the bottom" },
            shoes: { type: "STRING", description: "Description of the shoes" },
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
    if (userContext.sex) parts.push(`Sex: ${userContext.sex}`);
    if (userContext.preferences) parts.push(`Style preferences: ${userContext.preferences}`);
    if (parts.length > 0) {
      instruction += `\n\nUSER CONTEXT:\n${parts.join("\n")}`;
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
 */
async function createSession(sessionId, clientWs, userContext) {
  const ai = getClient();

  console.log(`[giselle-live] Creating session ${sessionId}`);

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
    },
    callbacks: {
      onopen: () => {
        console.log(`[giselle-live] Session ${sessionId} connected to Gemini`);
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
        cleanup(sessionId);
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

  sessions.set(sessionId, { session, clientWs, heartbeat });
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

  // Server going away
  if (msg.goAway) {
    sendToClient(clientWs, {
      type: "go_away",
      timeLeft: msg.goAway.timeLeft,
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
  sendText,
  sendToolResponse,
  sendAudioEnd,
  closeSession,
};
