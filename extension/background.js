/**
 * GeminiTryOnMe - Background Service Worker
 *
 * Routes messages between content scripts, popup, and the backend API.
 * Handles auth token injection for all API calls.
 */

const DEFAULT_BACKEND_URL = "https://geminitryonme-backend-81189935460.us-central1.run.app";

async function getBackendUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["backendUrl"], (result) => {
      resolve(result.backendUrl || DEFAULT_BACKEND_URL);
    });
  });
}

/**
 * Get stored auth tokens if available.
 */
async function getAuthTokens() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authTokens"], (result) => {
      resolve(result.authTokens || null);
    });
  });
}

/**
 * Ensure the auth token is fresh. If it expires within 5 minutes, refresh proactively.
 */
async function ensureFreshToken() {
  const tokens = await getAuthTokens();
  if (!tokens || !tokens.idToken) return;

  // Refresh if token expires within 5 minutes (or expiresAt is missing)
  const bufferMs = 5 * 60 * 1000;
  if (tokens.expiresAt && Date.now() < tokens.expiresAt - bufferMs) return;

  console.log("[bg] Token expiring soon — proactively refreshing");
  await tryRefreshToken();
}

/**
 * Build headers including auth token if available.
 */
async function buildHeaders() {
  await ensureFreshToken();
  const headers = { "Content-Type": "application/json" };
  const tokens = await getAuthTokens();
  if (tokens && tokens.idToken) {
    headers["Authorization"] = `Bearer ${tokens.idToken}`;
  }
  return headers;
}

/**
 * Try to refresh the auth token if we get a 401.
 */
async function tryRefreshToken() {
  const tokens = await getAuthTokens();
  if (!tokens || !tokens.refreshToken) return false;

  try {
    const backendUrl = await getBackendUrl();
    const resp = await fetch(`${backendUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!resp.ok) return false;
    const newTokens = await resp.json();
    await chrome.storage.local.set({
      authTokens: {
        ...tokens,
        idToken: newTokens.idToken,
        accessToken: newTokens.accessToken,
        expiresAt: Date.now() + (newTokens.expiresIn * 1000),
      },
    });
    return true;
  } catch (err) {
    console.warn("[bg] Token refresh failed:", err.message);
    return false;
  }
}

/**
 * Forward an API request to the backend with auth headers and 401 retry.
 */
async function apiFetch(method, endpoint, data, retry = true) {
  const backendUrl = await getBackendUrl();
  const url = `${backendUrl}${endpoint}`;
  const headers = await buildHeaders();

  const opts = { method, headers };
  if (data !== undefined) {
    opts.body = JSON.stringify(data);
  }

  console.log(`[bg] fetch: ${method} ${url}`);
  const response = await fetch(url, opts);
  console.log(`[bg] fetch response: ${method} ${endpoint} → ${response.status}`);

  if (response.status === 401 && retry) {
    console.log(`[bg] 401 received, attempting token refresh...`);
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      console.log(`[bg] Token refreshed, retrying ${method} ${endpoint}`);
      return apiFetch(method, endpoint, data, false);
    }
    console.warn(`[bg] Token refresh failed, returning 401 error`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[bg] API error: ${method} ${endpoint} → ${response.status}: ${errorText}`);
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

function apiPost(endpoint, data) { return apiFetch("POST", endpoint, data); }
function apiGet(endpoint) { return apiFetch("GET", endpoint); }
function apiDelete(endpoint) { return apiFetch("DELETE", endpoint); }
function apiPut(endpoint, data) { return apiFetch("PUT", endpoint, data); }

// Allowed image CDN domains for proxy fetch (prevents open-proxy abuse)
const ALLOWED_IMAGE_HOSTS = [
  "m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-eu.ssl-images-amazon.com",
  "img.ltwebstatic.com", "img.kwcdn.com",
  "ae01.alicdn.com", "i.imgur.com",
  "encrypted-tbn0.gstatic.com", "encrypted-tbn1.gstatic.com", "encrypted-tbn2.gstatic.com", "encrypted-tbn3.gstatic.com",
  "lh3.googleusercontent.com", "shopping.googleusercontent.com",
];

async function proxyImageFetch(imageUrl) {
  // Validate URL against allowed CDN domains
  try {
    const parsed = new URL(imageUrl);
    if (!ALLOWED_IMAGE_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
      throw new Error(`Image proxy blocked: ${parsed.hostname} is not an allowed CDN`);
    }
  } catch (e) {
    if (e.message.includes("proxy blocked")) throw e;
    throw new Error("Invalid image URL for proxy");
  }

  const response = await fetch(imageUrl);
  const blob = await response.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function getStoredPhotos() {
  const result = await chrome.storage.local.get(["bodyPhoto", "facePhoto", "selectedPoseIndex"]);
  let bodyPhoto = result.bodyPhoto || null;
  let facePhoto = result.facePhoto || null;
  const selectedPoseIndex = result.selectedPoseIndex ?? 0;

  // If photos are missing from local storage, fetch from backend (GCS)
  if (!bodyPhoto || !facePhoto) {
    try {
      const allPhotos = await apiGet("/api/profile/photos/all");
      if (!bodyPhoto && allPhotos.generated && allPhotos.generated[selectedPoseIndex]) {
        bodyPhoto = allPhotos.generated[selectedPoseIndex];
        // Cache locally for next time
        await chrome.storage.local.set({ bodyPhoto });
      }
      if (!facePhoto && allPhotos.originals) {
        // Use last original as face photo (face photos are uploaded last in wizard)
        const faceImg = allPhotos.originals[allPhotos.originals.length - 1];
        if (faceImg) {
          facePhoto = faceImg;
          await chrome.storage.local.set({ facePhoto });
        }
      }
    } catch (err) {
      console.warn("[background] Failed to fetch photos from backend:", err.message);
    }
  }

  return { bodyPhoto, facePhoto, selectedPoseIndex };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_USER_PHOTOS": {
          const photos = await getStoredPhotos();
          sendResponse({ data: photos });
          break;
        }

        case "GET_AUTH_STATUS": {
          const tokens = await getAuthTokens();
          const isAuthenticated = !!(tokens && tokens.idToken);
          sendResponse({ data: { isAuthenticated } });
          break;
        }

        case "ANALYZE_PRODUCT": {
          const result = await apiPost("/api/analyze", {
            productImage: message.imageBase64,
            title: message.title,
            breadcrumbs: message.breadcrumbs,
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON": {
          console.log(`[background] TRY_ON — framing: "${message.framing}", poseIndex: ${message.poseIndex}, garmentClass: "${message.garmentClass}", title: "${message.productTitle || ""}"`);
          const result = await apiPost("/api/try-on", {
            sourceImage: message.bodyImageBase64,
            referenceImage: message.garmentImageBase64,
            garmentClass: message.garmentClass,
            mergeStyle: message.mergeStyle || "SEAMLESS",
            framing: message.framing || "full",
            poseIndex: message.poseIndex ?? 0,
            quickMode: message.quickMode || false,
            productTitle: message.productTitle || "",
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON_OUTFIT": {
          const result = await apiPost("/api/try-on/outfit", {
            sourceImage: message.bodyImageBase64 || null,
            garments: message.garments,
            framing: message.framing || "full",
            poseIndex: message.poseIndex ?? 0,
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON_COSMETICS": {
          const result = await apiPost("/api/cosmetics", {
            faceImage: message.faceImageBase64,
            cosmeticType: message.cosmeticType,
            color: message.color,
          });
          sendResponse({ data: result });
          break;
        }

        case "TRY_ON_ACCESSORY": {
          const result = await apiPost("/api/accessories", {
            faceImage: message.faceImageBase64,
            productImage: message.productImageBase64,
            accessoryType: message.accessoryType,
          });
          sendResponse({ data: result });
          break;
        }

        case "GENERATE_VIDEO": {
          const result = await apiPost("/api/video", {
            image: message.imageBase64,
            prompt: message.prompt,
          });
          sendResponse({ data: result });
          break;
        }

        case "GET_VIDEO_STATUS": {
          const provider = message.provider || "veo";
          const result = await apiGet(`/api/video/${message.jobId}?provider=${provider}`);
          sendResponse({ data: result });
          break;
        }

        case "REMOVE_BG": {
          const result = await apiPost("/api/image/remove-bg", {
            image: message.imageBase64,
          });
          sendResponse({ data: result });
          break;
        }

        case "SET_BACKEND_URL": {
          const newUrl = message.url;
          await chrome.storage.local.set({ backendUrl: newUrl });
          sendResponse({ data: { backendUrl: newUrl } });
          break;
        }

        case "VOICE_CHAT": {
          const result = await apiPost("/api/voice", {
            message: message.text,
            history: message.history || [],
            userContext: message.userContext || {},
          });
          sendResponse({ data: result });
          break;
        }

        case "SMART_SEARCH": {
          const result = await apiPost("/api/smart-search", {
            query: message.query,
          });
          sendResponse({ data: result });
          break;
        }

        case "SHARE_EMAIL": {
          const result = await apiPost("/api/share/email", {
            recipientEmail: message.recipientEmail,
            message: message.message || "",
            resultImage: message.resultImage,
            productTitle: message.productTitle || "",
          });
          sendResponse({ data: result });
          break;
        }

        case "PROXY_IMAGE": {
          const base64 = await proxyImageFetch(message.url);
          sendResponse({ data: base64 });
          break;
        }

        case "API_CALL": {
          const method = (message.method || "").toUpperCase();
          const endpoint = message.endpoint;
          console.log(`[bg] API_CALL: ${method} ${endpoint}`);

          // Whitelist allowed API endpoints to prevent abuse from compromised content scripts
          const ALLOWED_PREFIXES = [
            "/api/auth", "/api/profile", "/api/favorites", "/api/try-on", "/api/cosmetics",
            "/api/accessories", "/api/video", "/api/analyze", "/api/image",
            "/api/smart-search", "/api/voice", "/api/cart", "/api/share",
          ];
          if (!ALLOWED_PREFIXES.some(p => endpoint.startsWith(p))) {
            console.warn(`[bg] Blocked endpoint: ${endpoint}`);
            sendResponse({ error: `Endpoint not allowed: ${endpoint}` });
            break;
          }

          let result;
          const startTime = Date.now();

          if (method === "PUT") {
            result = await apiPut(endpoint, message.data || {});
          } else if (method === "DELETE") {
            result = await apiDelete(endpoint);
          } else if (method === "GET" || !message.data || Object.keys(message.data).length === 0) {
            result = await apiGet(endpoint);
          } else {
            result = await apiPost(endpoint, message.data);
          }
          console.log(`[bg] API_CALL done: ${method} ${endpoint} (${Date.now() - startTime}ms)`);
          sendResponse({ data: result });
          break;
        }

        case "GET_PHOTOS": {
          const photos = await getStoredPhotos();
          sendResponse({ data: photos });
          break;
        }

        case "ADD_TO_CART": {
          const result = await apiPost("/api/cart/add", {
            productUrl: message.productUrl,
            quantity: message.quantity || 1,
          });
          sendResponse({ data: result });
          break;
        }

        case "SAVE_TO_FAVORITES": {
          // Forward to active tab's content script to trigger the save-to-favorites button
          const [favTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (favTab?.id) {
            chrome.tabs.sendMessage(favTab.id, { type: "SAVE_TO_FAVORITES" }, (res) => {
              sendResponse({ data: res || { success: true } });
            });
          } else {
            sendResponse({ error: "No active tab found" });
          }
          break;
        }

        case "SAVE_VIDEO": {
          // Forward to active tab's content script to trigger the save-video button
          const [vidTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (vidTab?.id) {
            chrome.tabs.sendMessage(vidTab.id, { type: "SAVE_VIDEO" }, (res) => {
              sendResponse({ data: res || { success: true } });
            });
          } else {
            sendResponse({ error: "No active tab found" });
          }
          break;
        }

        case "OPEN_POPUP": {
          // Open the side panel instead of popup
          if (_sender.tab) {
            await chrome.sidePanel.open({ tabId: _sender.tab.id });
          }
          sendResponse({ data: { opened: true } });
          break;
        }

        case "CAPTURE_TAB_SCREENSHOT": {
          // Capture a screenshot of the currently visible tab (used for voice agent vision)
          try {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (tab) {
              const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
              sendResponse({ data: dataUrl });
            } else {
              sendResponse({ data: null });
            }
          } catch (err) {
            console.warn("[background] Screenshot capture failed:", err.message);
            sendResponse({ data: null });
          }
          break;
        }

        case "OPEN_URL": {
          // Open a URL in a new tab — used by content scripts that can't window.open due to CSP
          if (message.url) {
            chrome.tabs.create({ url: message.url });
          }
          sendResponse({ data: { opened: true } });
          break;
        }

        default:
          sendResponse({ error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error("[GeminiTryOnMe background] Error:", err);
      sendResponse({ error: err.message });
    }
  })();

  return true;
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Also handle OPEN_POPUP messages from content script (now opens side panel)
// This is handled inside the message listener but we also set side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------------------------------------------------------------------------
// Context Menu — "Try On with Gemini TryOnMe" on right-click any image
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "gemini-tryon-image",
    title: "Try On with Gemini TryOnMe",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "gemini-tryon-image") return;
  const imageUrl = info.srcUrl;
  if (!imageUrl) return;

  console.log("[bg] Context menu try-on for image:", imageUrl?.substring(0, 80));

  // Check if content script is already injected
  let alreadyInjected = false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => !!window.__novaTryOnMeLoaded,
    });
    alreadyInjected = result?.result === true;
  } catch (_) {}

  if (!alreadyInjected) {
    // Inject content scripts dynamically on unsupported sites
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles/content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/scraper-registry.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/image-utils.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["utils/api-client.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (err) {
      console.warn("[bg] Failed to inject content scripts:", err.message);
    }
  }

  // Send the image URL to content script
  const delay = alreadyInjected ? 100 : 500;
  setTimeout(() => {
    chrome.tabs.sendMessage(tab.id, {
      type: "CONTEXT_MENU_TRYON",
      imageUrl,
      pageUrl: info.pageUrl,
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[bg] Context menu message:", chrome.runtime.lastError.message);
      }
    });
  }, delay);
});

console.log("[GeminiTryOnMe] Background service worker started.");
