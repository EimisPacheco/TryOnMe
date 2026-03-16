/**
 * Voice Agent (Giselle) Tests
 *
 * Tests for the voice agent's tool declarations, system prompt,
 * session management, and message handling.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSession = {
  sendRealtimeInput: jest.fn(),
  sendClientContent: jest.fn(),
  sendToolResponse: jest.fn(),
  close: jest.fn(),
};

// Shared mock connect function so we can inspect calls across all GoogleGenAI instances
const mockConnect = jest.fn().mockImplementation(async (config) => {
  if (config.callbacks?.onopen) config.callbacks.onopen();
  return mockSession;
});

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    live: { connect: mockConnect },
  })),
  Modality: { AUDIO: "AUDIO" },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const giselleLive = require("../services/giselleLive");

// ---------------------------------------------------------------------------
// Helper: create a mock WebSocket
// ---------------------------------------------------------------------------

function createMockWs() {
  const sent = [];
  return {
    readyState: 1, // OPEN
    send: jest.fn((data) => sent.push(JSON.parse(data))),
    ping: jest.fn(),
    _sent: sent,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Voice Agent — Tool Declarations", () => {
  // We need to access the GISELLE_TOOLS from the module.
  // Since they're not exported, we re-read the file and parse tool names.
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../services/giselleLive.js"),
    "utf-8"
  );

  test("declares exactly 8 tools", () => {
    // Count all `name: "..."` inside functionDeclarations
    const toolNames = [...source.matchAll(/name:\s*"(\w+)"/g)].map((m) => m[1]);
    expect(toolNames).toHaveLength(8);
  });

  test("includes all required tool names", () => {
    const expected = [
      "search_product",
      "add_to_cart",
      "try_on",
      "build_outfit",
      "show_favorites",
      "save_to_favorites",
      "save_video",
      "show_videos",
    ];
    for (const name of expected) {
      expect(source).toContain(`name: "${name}"`);
    }
  });

  test("build_outfit has all 6 category parameters", () => {
    const categories = ["top", "bottom", "shoes", "necklace", "earrings", "bracelet"];
    // Extract the build_outfit block
    const buildOutfitIdx = source.indexOf('name: "build_outfit"');
    const nextToolIdx = source.indexOf('name: "show_favorites"');
    const block = source.substring(buildOutfitIdx, nextToolIdx);

    for (const cat of categories) {
      expect(block).toContain(`${cat}:`);
    }
  });

  test("try_on has optional itemNumber parameter", () => {
    const tryOnIdx = source.indexOf('name: "try_on"');
    const nextToolIdx = source.indexOf('name: "build_outfit"');
    const block = source.substring(tryOnIdx, nextToolIdx);
    expect(block).toContain("itemNumber");
    expect(block).toContain("NUMBER");
  });

  test("save_to_favorites, save_video, show_videos have no required params", () => {
    const noParamTools = ["save_to_favorites", "save_video", "show_videos"];
    for (const tool of noParamTools) {
      const idx = source.indexOf(`name: "${tool}"`);
      // Find the next "properties: {}" after this tool
      const block = source.substring(idx, idx + 300);
      expect(block).toContain("properties: {}");
    }
  });
});

describe("Voice Agent — System Prompt", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../services/giselleLive.js"),
    "utf-8"
  );

  test("contains outfit builder confirmation flow instructions", () => {
    expect(source).toContain("OUTFIT BUILDER FLOW");
    expect(source).toContain("6 categories: top, bottom, shoes, necklace, earrings, bracelet");
    expect(source).toContain("NEVER call build_outfit immediately");
    expect(source).toContain("ONLY after the user explicitly confirms");
  });

  test("contains saving & videos instructions", () => {
    expect(source).toContain("SAVING & VIDEOS");
    expect(source).toContain("save_to_favorites");
    expect(source).toContain("save_video");
    expect(source).toContain("show_videos");
    expect(source).toContain("show_favorites");
  });

  test("mentions all 6 outfit categories as having 3 main + 3 optional", () => {
    expect(source).toContain("top, bottom, shoes");
    expect(source).toContain("necklace, earrings, bracelet");
    expect(source).toContain("optional accessories");
  });
});

describe("Voice Agent — buildSystemInstruction", () => {
  // We can test this indirectly via createSession — the config passed to live.connect

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("includes user context when provided", async () => {
    const ws = createMockWs();

    await giselleLive.createSession("test-ctx-1", ws, {
      name: "Alice",
      size: "M",
      shoesSize: "8",
      sex: "female",
      preferences: "boho chic",
    });

    const connectCall = mockConnect.mock.calls[mockConnect.mock.calls.length - 1];
    const sysInstruction = connectCall[0].config.systemInstruction;

    expect(sysInstruction).toContain("Alice");
    expect(sysInstruction).toContain("Clothing size: M");
    expect(sysInstruction).toContain("Shoes size: 8");
    expect(sysInstruction).toContain("Sex: female");
    expect(sysInstruction).toContain("boho chic");
    expect(sysInstruction).toContain("USER CONTEXT");

    giselleLive.closeSession("test-ctx-1");
  });

  test("includes language instruction for non-English", async () => {
    const ws = createMockWs();

    await giselleLive.createSession("test-ctx-lang", ws, {
      name: "Carlos",
      language: "es",
    });

    const connectCall = mockConnect.mock.calls[mockConnect.mock.calls.length - 1];
    const sysInstruction = connectCall[0].config.systemInstruction;

    expect(sysInstruction).toContain("LANGUAGE");
    expect(sysInstruction).toContain("Spanish");
    expect(sysInstruction).toContain("Carlos");

    giselleLive.closeSession("test-ctx-lang");
  });

  test("works without user context", async () => {
    const ws = createMockWs();

    await giselleLive.createSession("test-ctx-2", ws, {});

    const connectCall = mockConnect.mock.calls[mockConnect.mock.calls.length - 1];
    const sysInstruction = connectCall[0].config.systemInstruction;

    expect(sysInstruction).toContain("You are Giselle");
    expect(sysInstruction).not.toContain("USER CONTEXT");

    giselleLive.closeSession("test-ctx-2");
  });
});

describe("Voice Agent — Session Management", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("createSession sends setup_complete to client", async () => {
    const ws = createMockWs();
    await giselleLive.createSession("test-setup", ws, {});

    expect(ws._sent).toContainEqual({ type: "setup_complete" });

    giselleLive.closeSession("test-setup");
  });

  test("sendText forwards to Gemini session", async () => {
    const ws = createMockWs();
    await giselleLive.createSession("test-text", ws, {});

    giselleLive.sendText("test-text", "find me a red dress");

    expect(mockSession.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: "find me a red dress" }] }],
      turnComplete: true,
    });

    giselleLive.closeSession("test-text");
  });

  test("sendAudio forwards PCM data to Gemini session", async () => {
    const ws = createMockWs();
    await giselleLive.createSession("test-audio", ws, {});

    giselleLive.sendAudio("test-audio", "base64audiodata");

    expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
      audio: {
        data: "base64audiodata",
        mimeType: "audio/pcm;rate=16000",
      },
    });

    giselleLive.closeSession("test-audio");
  });

  test("sendToolResponse forwards to Gemini session", async () => {
    const ws = createMockWs();
    await giselleLive.createSession("test-tool-resp", ws, {});

    const responses = [{ id: "call-1", name: "search_product", response: { result: "done" } }];
    giselleLive.sendToolResponse("test-tool-resp", responses);

    expect(mockSession.sendToolResponse).toHaveBeenCalledWith({ functionResponses: responses });

    giselleLive.closeSession("test-tool-resp");
  });

  test("sendAudioEnd signals end of audio stream", async () => {
    const ws = createMockWs();
    await giselleLive.createSession("test-audio-end", ws, {});

    giselleLive.sendAudioEnd("test-audio-end");

    expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });

    giselleLive.closeSession("test-audio-end");
  });

  test("closeSession calls session.close() and cleans up", async () => {
    const ws = createMockWs();
    await giselleLive.createSession("test-close", ws, {});

    giselleLive.closeSession("test-close");

    expect(mockSession.close).toHaveBeenCalled();
  });

  test("operations on non-existent session are no-ops", () => {
    // These should not throw
    giselleLive.sendAudio("nonexistent", "data");
    giselleLive.sendText("nonexistent", "hello");
    giselleLive.sendToolResponse("nonexistent", []);
    giselleLive.sendAudioEnd("nonexistent");
    giselleLive.closeSession("nonexistent");
  });
});

describe("Voice Agent — handleServerMessage (via createSession callbacks)", () => {
  let ws;

  beforeEach(async () => {
    jest.clearAllMocks();
    ws = createMockWs();
  });

  test("forwards tool_call messages to client", async () => {
    await giselleLive.createSession("test-toolcall", ws, {});

    // Get the onmessage callback
    const connectCall = mockConnect.mock.calls[mockConnect.mock.calls.length - 1];
    const onmessage = connectCall[0].callbacks.onmessage;

    // Simulate Gemini sending a tool call
    onmessage({
      toolCall: {
        functionCalls: [
          { id: "fc-1", name: "build_outfit", args: { top: "white blouse", bottom: "blue jeans", shoes: "sneakers", necklace: "gold chain" } },
        ],
      },
    });

    const toolCallMsg = ws._sent.find((m) => m.type === "tool_call");
    expect(toolCallMsg).toBeTruthy();
    expect(toolCallMsg.functionCalls).toHaveLength(1);
    expect(toolCallMsg.functionCalls[0].name).toBe("build_outfit");
    expect(toolCallMsg.functionCalls[0].args.necklace).toBe("gold chain");

    giselleLive.closeSession("test-toolcall");
  });

  test("forwards audio data to client", async () => {
    await giselleLive.createSession("test-audio-fwd", ws, {});

    const connectCall = mockConnect.mock.calls[mockConnect.mock.calls.length - 1];
    const onmessage = connectCall[0].callbacks.onmessage;

    onmessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: "audiobase64", mimeType: "audio/pcm" } }],
        },
      },
    });

    const audioMsg = ws._sent.find((m) => m.type === "audio");
    expect(audioMsg).toBeTruthy();
    expect(audioMsg.data).toBe("audiobase64");

    giselleLive.closeSession("test-audio-fwd");
  });

  test("forwards turn_complete to client", async () => {
    await giselleLive.createSession("test-turn", ws, {});

    const connectCall = mockConnect.mock.calls[mockConnect.mock.calls.length - 1];
    const onmessage = connectCall[0].callbacks.onmessage;

    onmessage({ serverContent: { turnComplete: true } });

    expect(ws._sent).toContainEqual({ type: "turn_complete" });

    giselleLive.closeSession("test-turn");
  });

  test("forwards transcriptions to client", async () => {
    await giselleLive.createSession("test-transcription", ws, {});

    const connectCall = mockConnect.mock.calls[mockConnect.mock.calls.length - 1];
    const onmessage = connectCall[0].callbacks.onmessage;

    onmessage({ serverContent: { inputTranscription: { text: "find me shoes" } } });
    onmessage({ serverContent: { outputTranscription: { text: "I found some great shoes!" } } });

    const inputT = ws._sent.find((m) => m.type === "input_transcription");
    const outputT = ws._sent.find((m) => m.type === "output_transcription");
    expect(inputT.text).toBe("find me shoes");
    expect(outputT.text).toBe("I found some great shoes!");

    giselleLive.closeSession("test-transcription");
  });
});

describe("Voice Agent — WebSocket Route Handler", () => {
  const handleConnection = require("../routes/voiceLive");

  test("rejects invalid JSON", () => {
    const ws = createMockWs();
    const handlers = {};
    ws.on = jest.fn((event, cb) => { handlers[event] = cb; });

    handleConnection(ws, {});

    // Send invalid JSON
    handlers.message(Buffer.from("not json"));

    const errorMsg = ws._sent.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg.message).toBe("Invalid JSON");
  });

  test("rejects unknown message types", () => {
    const ws = createMockWs();
    const handlers = {};
    ws.on = jest.fn((event, cb) => { handlers[event] = cb; });

    handleConnection(ws, {});

    handlers.message(Buffer.from(JSON.stringify({ type: "unknown_type" })));

    const errorMsg = ws._sent.find((m) => m.type === "error");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg.message).toContain("Unknown message type");
  });

  test("creates session on 'start' message", async () => {
    const ws = createMockWs();
    const handlers = {};
    ws.on = jest.fn((event, cb) => { handlers[event] = cb; });

    handleConnection(ws, {});

    await handlers.message(Buffer.from(JSON.stringify({
      type: "start",
      userContext: { name: "TestUser" },
    })));

    // Should have received setup_complete
    const setupMsg = ws._sent.find((m) => m.type === "setup_complete");
    expect(setupMsg).toBeTruthy();
  });

  test("prevents double session start", async () => {
    const ws = createMockWs();
    const handlers = {};
    ws.on = jest.fn((event, cb) => { handlers[event] = cb; });

    handleConnection(ws, {});

    await handlers.message(Buffer.from(JSON.stringify({ type: "start" })));
    await handlers.message(Buffer.from(JSON.stringify({ type: "start" })));

    const errorMsgs = ws._sent.filter((m) => m.type === "error");
    expect(errorMsgs.some((m) => m.message === "Session already started")).toBe(true);
  });

  test("ignores audio before session start", async () => {
    const ws = createMockWs();
    const handlers = {};
    ws.on = jest.fn((event, cb) => { handlers[event] = cb; });

    handleConnection(ws, {});

    // Send audio without starting session — should be silently ignored
    await handlers.message(Buffer.from(JSON.stringify({ type: "audio", data: "abc" })));
    expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
  });
});
