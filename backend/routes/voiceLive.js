/**
 * Voice Live WebSocket Handler
 *
 * Handles WebSocket connections for real-time voice streaming
 * between the Chrome extension and Gemini Live API.
 */

const crypto = require("crypto");
const giselleLive = require("../services/giselleLive");

/**
 * WebSocket connection handler — called by WebSocketServer on 'connection' event.
 *
 * @param {WebSocket} ws - Client WebSocket connection
 * @param {http.IncomingMessage} req - HTTP upgrade request
 */
function handleConnection(ws, req) {
  const sessionId = crypto.randomUUID();
  let sessionReady = false;

  console.log(`[voice-live] New connection: ${sessionId}`);

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.type) {
      case "start": {
        // Initialize Gemini Live session
        if (sessionReady) {
          ws.send(JSON.stringify({ type: "error", message: "Session already started" }));
          return;
        }
        try {
          await giselleLive.createSession(sessionId, ws, msg.userContext || {});
          sessionReady = true;
        } catch (err) {
          console.error(`[voice-live] Session creation failed:`, err.message);
          ws.send(JSON.stringify({ type: "error", message: "Failed to start voice session" }));
        }
        break;
      }

      case "audio": {
        if (!sessionReady) return;
        if (!msg.data) return;
        giselleLive.sendAudio(sessionId, msg.data);
        break;
      }

      case "audio_end": {
        if (!sessionReady) return;
        giselleLive.sendAudioEnd(sessionId);
        break;
      }

      case "text": {
        if (!sessionReady) return;
        if (!msg.text || typeof msg.text !== "string") return;
        giselleLive.sendText(sessionId, msg.text);
        break;
      }

      case "tool_response": {
        if (!sessionReady) return;
        if (!msg.functionResponses) return;
        giselleLive.sendToolResponse(sessionId, msg.functionResponses);
        break;
      }

      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
    }
  });

  ws.on("close", () => {
    console.log(`[voice-live] Connection closed: ${sessionId}`);
    if (sessionReady) {
      giselleLive.closeSession(sessionId);
      sessionReady = false;
    }
  });

  ws.on("error", (err) => {
    console.error(`[voice-live] WebSocket error for ${sessionId}:`, err.message);
    if (sessionReady) {
      giselleLive.closeSession(sessionId);
      sessionReady = false;
    }
  });
}

module.exports = handleConnection;
