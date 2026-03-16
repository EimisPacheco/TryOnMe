/**
 * GeminiTryOnMe - Content Script
 *
 * Injected into Amazon product pages. Orchestrates product analysis,
 * "Try It On" button injection, and the try-on panel experience.
 *
 * Dependencies (loaded before this file via manifest content_scripts):
 *   - utils/amazon-scraper.js  -> scrapeProductData()
 *   - utils/image-utils.js     -> fetchImageAsBase64(), base64ToDataUrl()
 *   - utils/api-client.js      -> ApiClient (static methods use message passing)
 */

(function () {
  "use strict";

  // Guard against double-injection
  if (window.__novaTryOnMeLoaded) return;
  window.__novaTryOnMeLoaded = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let productData = null; // { imageUrl, title, breadcrumbs, productId, price, retailer }
  let productImageBase64 = null;
  let analysisResult = null; // Cached backend analysis response
  let panelOpen = false;
  let overlayCard = null; // The overlay element when open
  let currentPhotos = null; // Cached user photos for auto-refresh
  let currentIsCosmetic = false; // Cached cosmetic flag
  let currentIsAccessory = false; // Cached accessory flag

  // Non-blocking toast notification for content script context
  function showPageToast(msg, duration = 3500) {
    let toast = document.getElementById('nova-tryon-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'nova-tryon-toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:#1a1a2e;color:#fff;padding:12px 24px;border-radius:12px;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,0.3);transition:transform 0.3s ease,opacity 0.3s ease;opacity:0;max-width:400px;text-align:center;border:1px solid rgba(196,75,255,0.3);';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    // Trigger animation
    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(-50%) translateY(0)';
      toast.style.opacity = '1';
    });
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.style.transform = 'translateX(-50%) translateY(100px)';
      toast.style.opacity = '0';
    }, duration);
  }
  let lastImageUrl = null; // Track last image URL to detect real changes
  let tryOnEnabled = false; // Toggle switch state: when ON, swatch clicks auto-trigger try-on
  let currentFraming = 'full'; // half or full body framing
  let tryOnRequestId = 0; // Incremented per try-on call to prevent stale results

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  async function init() {
    console.log("[GeminiTryOnMe] Content script initializing...");

    // Load framing preference from storage
    try {
      const stored = await chrome.storage.local.get(["tryOnFraming"]);
      if (stored.tryOnFraming) currentFraming = stored.tryOnFraming;
    } catch (_) {}

    // 1. Scrape the product page (retry if Temu hasn't loaded real images yet)
    productData = scrapeProductData();
    if (!productData.imageUrl || productData.imageUrl.startsWith("data:")) {
      // Temu lazy-loads images — wait up to 5s for a real CDN image
      const host = window.location.hostname;
      if (host.includes("temu.")) {
        console.log("[GeminiTryOnMe] Temu: waiting for real product image to load...");
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(r => setTimeout(r, 500));
          productData = scrapeProductData();
          if (productData.imageUrl && !productData.imageUrl.startsWith("data:")) break;
        }
      }
    }
    if (!productData.imageUrl || productData.imageUrl.startsWith("data:")) {
      console.warn("[GeminiTryOnMe] Could not find product image. Aborting.");
      return;
    }
    console.log("[GeminiTryOnMe] Product scraped:", productData.title);

    // 2. Fetch the product image as base64
    try {
      productImageBase64 = await fetchImageAsBase64(productData.imageUrl);
    } catch (err) {
      console.error("[GeminiTryOnMe] Failed to fetch product image:", err);
      return;
    }

    // 3. Analyze the product via the backend (Gemini classifier)
    try {
      analysisResult = await ApiClient.analyzeProduct(
        productImageBase64,
        productData.title,
        productData.breadcrumbs
      );
      console.log("[GeminiTryOnMe] Analysis result:", analysisResult);
    } catch (err) {
      console.error("[GeminiTryOnMe] Product analysis failed:", err);
      // Still inject the button so the user can retry
    }

    // 4. Only inject the button if the product is a supported category
    if (analysisResult && analysisResult.supported === false) {
      console.log("[GeminiTryOnMe] Product not supported for try-on.");
      return;
    }

    // 5. Inject UI elements
    injectTryOnButton();

    // 6. Watch for color/variation swatch changes
    setupVariationObserver();
  }

  // ---------------------------------------------------------------------------
  // Listen for pose/framing changes from the side panel
  // ---------------------------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.tryOnFraming) {
      currentFraming = changes.tryOnFraming.newValue || 'full';
      console.log("[GeminiTryOnMe] Framing changed to:", currentFraming);
    }

    // Re-trigger try-on if overlay is open and pose or framing changed
    if ((changes.selectedPoseIndex || changes.tryOnFraming) && overlayCard && currentPhotos) {
      console.log("[GeminiTryOnMe] Pose/framing changed — re-triggering try-on");
      performTryOn(overlayCard, currentPhotos, currentIsCosmetic);
    }
  });

  // ---------------------------------------------------------------------------
  // Context Menu "Try On" — handle right-click on any image
  // ---------------------------------------------------------------------------
  let contextMenuImageUrl = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Voice agent: save to favorites
    if (msg.type === "SAVE_TO_FAVORITES") {
      const favBtn = document.querySelector(".nova-tryon-favorite-btn:not(.nova-tryon-favorite-btn--saved)");
      if (favBtn) {
        favBtn.click();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: "No unsaved try-on result found" });
      }
      return false;
    }

    // Voice agent: save video
    if (msg.type === "SAVE_VIDEO") {
      const saveBtn = document.querySelector(".nova-tryon-save-video-btn:not(:disabled)");
      if (saveBtn) {
        saveBtn.click();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: "No video to save" });
      }
      return false;
    }

    if (msg.type !== "CONTEXT_MENU_TRYON") return false;
    console.log("[GeminiTryOnMe] Context menu try-on triggered:", msg.imageUrl?.substring(0, 80));
    contextMenuImageUrl = msg.imageUrl;

    (async () => {
      try {
        // If product data wasn't scraped, create minimal data from the image
        if (!productData || !productData.imageUrl) {
          productData = {
            imageUrl: msg.imageUrl,
            title: document.title || "",
            breadcrumbs: "",
            productId: null,
            price: null,
            retailer: window.location.hostname.replace("www.", "").split(".")[0],
            productUrl: msg.pageUrl || window.location.href,
          };
        } else {
          productData.imageUrl = msg.imageUrl;
        }

        // Fetch the right-clicked image as base64
        productImageBase64 = await fetchImageAsBase64(msg.imageUrl);

        // Analyze the product
        try {
          analysisResult = await ApiClient.analyzeProduct(
            productImageBase64,
            productData.title,
            productData.breadcrumbs
          );
          console.log("[GeminiTryOnMe] Context menu analysis:", analysisResult);
        } catch (err) {
          console.warn("[GeminiTryOnMe] Context menu analysis failed:", err.message);
        }

        // Inject button if not present
        if (!document.querySelector(".nova-tryon-btn")) {
          injectTryOnButton();
        }

        // Fetch user photos and open overlay directly
        const photos = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "GET_USER_PHOTOS" }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (res && res.error) return reject(new Error(res.error));
            resolve(res.data || res);
          });
        });

        if (!photos || !photos.bodyPhoto) {
          // Open side panel so user can set up photos
          chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
          return;
        }

        const isCosmetic = analysisResult && analysisResult.category === "cosmetics";
        currentPhotos = photos;
        currentIsCosmetic = isCosmetic;
        openOverlay(photos, isCosmetic);
      } catch (err) {
        console.error("[GeminiTryOnMe] Context menu try-on failed:", err);
      }
    })();
  });

  // ---------------------------------------------------------------------------
  // "Try It On" Button
  // ---------------------------------------------------------------------------
  function injectTryOnButton() {
    // Guard: don't inject a duplicate button
    if (document.querySelector(".nova-tryon-btn")) return;

    // Use site-specific anchor from scraper registry
    const siteConfig = getSiteConfig();
    let anchor = null;
    const host = window.location.hostname;

    if (host.includes("temu.")) {
      // Temu uses hashed class names — find the gallery by walking up from a kwcdn/temu image
      const temuImgs = Array.from(document.querySelectorAll("img[src*='kwcdn.com'], img[src*='temu.com']"));
      const largeTemu = temuImgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
      const anchorImg = largeTemu || temuImgs[0];
      if (anchorImg) {
        let el = anchorImg.parentElement;
        for (let i = 0; i < 5 && el && el !== document.body; i++) {
          const r = el.getBoundingClientRect();
          if (r.width > 300 && r.height > 300) { anchor = el; break; }
          el = el.parentElement;
        }
        if (!anchor) anchor = anchorImg.parentElement;
      }
    } else {
      anchor = document.querySelector(siteConfig.buttonAnchor);
    }

    // Generic fallback: find the largest visible image and walk up to a suitable container
    if (!anchor) {
      const imgs = Array.from(document.querySelectorAll("img"));
      const largeImg = imgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
      if (largeImg) {
        let el = largeImg.parentElement;
        for (let i = 0; i < 5 && el && el !== document.body; i++) {
          const r = el.getBoundingClientRect();
          if (r.width > 200 && r.height > 200) { anchor = el; break; }
          el = el.parentElement;
        }
        if (!anchor) anchor = largeImg.closest("div");
      }
    }

    if (!anchor) {
      console.warn("[GeminiTryOnMe] No anchor element found for button.");
      return;
    }

    // Ensure relative positioning so absolute button works
    const anchorStyle = window.getComputedStyle(anchor);
    if (anchorStyle.position === "static") {
      anchor.style.position = "relative";
    }

    const btn = document.createElement("button");
    btn.className = "nova-tryon-btn nova-tryon-btn--pulse";
    btn.innerHTML = '<span class="nova-tryon-btn-icon">&#10024;</span> Try It On';
    btn.setAttribute("aria-label", "Virtual Try-On with Gemini TryOnMe Everything");

    // Tooltip element (hidden by default)
    const tooltip = document.createElement("div");
    tooltip.className = "nova-tryon-tooltip";
    tooltip.textContent = "Please upload your photos first";
    btn.appendChild(tooltip);

    btn.addEventListener("click", handleTryOnClick);

    // Insert as direct child of anchor — this survives swatch changes
    anchor.appendChild(btn);
    console.log("[GeminiTryOnMe] Try-On button injected into", siteConfig.retailer, "page.");
  }

  // ---------------------------------------------------------------------------
  // Button Click Handler (Toggle Switch: ON/OFF)
  // ---------------------------------------------------------------------------
  async function handleTryOnClick(e) {
    const btn = e.currentTarget;
    const tooltip = btn.querySelector(".nova-tryon-tooltip");

    // If already enabled, toggle OFF
    if (tryOnEnabled) {
      disableTryOn(btn);
      return;
    }

    // --- Turning ON: validate auth and photos first ---

    // Check if user is authenticated
    try {
      const authStatus = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(res && res.data ? res.data : { isAuthenticated: false });
        });
      });

      if (!authStatus.isAuthenticated) {
        tooltip.textContent = "Please sign in to use Try-On";
        tooltip.classList.add("nova-tryon-tooltip--visible");
        setTimeout(() => tooltip.classList.remove("nova-tryon-tooltip--visible"), 3000);
        chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
        return;
      }
    } catch (err) {
      console.warn("[GeminiTryOnMe] Auth status check failed, proceeding:", err.message);
    }

    // Check if user has uploaded photos
    let photos;
    try {
      photos = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "GET_USER_PHOTOS" }, (res) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve(res && res.data ? res.data : { bodyPhoto: null, facePhoto: null });
        });
      });
    } catch (err) {
      console.error("[GeminiTryOnMe] Failed to check user photos:", err);
      photos = { bodyPhoto: null, facePhoto: null };
    }

    // Determine if this is a cosmetics or accessories product
    let isCosmetic =
      analysisResult &&
      analysisResult.category &&
      analysisResult.category.toLowerCase().includes("cosmetic");

    let isAccessory =
      analysisResult &&
      analysisResult.category &&
      analysisResult.category.toLowerCase() === "accessories" &&
      !!analysisResult.accessoryType;

    // Fallback detection from page title/breadcrumbs when analysis failed
    if (!analysisResult && productData) {
      const titleLower = (productData.title || "").toLowerCase();
      const crumbsLower = (productData.breadcrumbs || "").toLowerCase();
      const combined = titleLower + " " + crumbsLower;
      if (/lipstick|lip\s*(gloss|balm|color|stain|tint)|eye\s*shadow|blush|foundation|concealer|mascara|eyeliner|makeup/i.test(combined)) {
        isCosmetic = true;
        // Set a minimal analysisResult for the try-on
        analysisResult = { category: "cosmetics", cosmeticType: /lipstick|lip/i.test(combined) ? "lipstick" : /eye\s*shadow/i.test(combined) ? "eyeshadow" : /blush/i.test(combined) ? "blush" : /mascara/i.test(combined) ? "mascara" : /eyeliner/i.test(combined) ? "eyeliner" : "lipstick", color: null };
      } else if (/earring|necklace|bracelet|ring|sunglasses/i.test(combined)) {
        isAccessory = true;
        analysisResult = { category: "accessories", accessoryType: /earring/i.test(combined) ? "earrings" : /necklace/i.test(combined) ? "necklace" : /bracelet/i.test(combined) ? "bracelet" : /sunglasses/i.test(combined) ? "sunglasses" : "earrings" };
      }
    }

    // Cosmetics and accessories need face photo; clothing needs body photo
    const requiredPhoto = (isCosmetic || isAccessory) ? photos.facePhoto : photos.bodyPhoto;

    if (!requiredPhoto) {
      tooltip.textContent = (isCosmetic || isAccessory) ? "Please upload your face photos first" : "Please upload your photos first";
      tooltip.classList.add("nova-tryon-tooltip--visible");
      setTimeout(() => tooltip.classList.remove("nova-tryon-tooltip--visible"), 3000);
      chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
      return;
    }

    // --- All checks passed: enable try-on mode ---
    enableTryOn(btn, photos, isCosmetic, isAccessory);
  }

  /**
   * Enable try-on mode: switch button to ON state, open overlay, trigger first try-on.
   */
  function enableTryOn(btn, photos, isCosmetic, isAccessory) {
    tryOnEnabled = true;
    currentPhotos = photos;
    currentIsCosmetic = isCosmetic;
    currentIsAccessory = isAccessory || false;

    // Update button appearance to "ON" state
    btn.classList.add("nova-tryon-btn--active");
    btn.classList.remove("nova-tryon-btn--pulse");
    btn.innerHTML = '<span class="nova-tryon-btn-icon">&#10024;</span> Try On: ON';
    // Re-add tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "nova-tryon-tooltip";
    tooltip.textContent = "Click to disable auto try-on";
    btn.appendChild(tooltip);

    console.log("[GeminiTryOnMe] Try-on mode ENABLED");

    // Open overlay with first try-on
    if (!panelOpen) {
      openOverlay(photos, isCosmetic);
    }
  }

  /**
   * Disable try-on mode: switch button to OFF state, close overlay.
   */
  function disableTryOn(btn) {
    tryOnEnabled = false;

    // Update button appearance back to "OFF" state
    btn.classList.remove("nova-tryon-btn--active");
    btn.classList.add("nova-tryon-btn--pulse");
    btn.innerHTML = '<span class="nova-tryon-btn-icon">&#10024;</span> Try It On';
    // Re-add tooltip
    const tooltip = document.createElement("div");
    tooltip.className = "nova-tryon-tooltip";
    tooltip.textContent = "Please upload your photos first";
    btn.appendChild(tooltip);

    console.log("[GeminiTryOnMe] Try-on mode DISABLED");

    // Close the overlay (don't double-disable toggle since we already set it to false above)
    closeOverlay(false);
  }

  // ---------------------------------------------------------------------------
  // Try-On Overlay (on top of product image)
  // ---------------------------------------------------------------------------
  function openOverlay(photos, isCosmetic) {
    panelOpen = true;

    // Find the product image container using site-specific selectors
    const siteConfig = getSiteConfig();
    let imageContainer = null;
    const host = window.location.hostname;

    if (host.includes("temu.")) {
      // Temu: walk up from kwcdn image to find a suitable container
      const temuImgs = Array.from(document.querySelectorAll("img[src*='kwcdn.com'], img[src*='temu.com']"));
      const largeTemu = temuImgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
      const anchorImg = largeTemu || temuImgs[0];
      if (anchorImg) {
        let el = anchorImg.parentElement;
        for (let i = 0; i < 5 && el && el !== document.body; i++) {
          const r = el.getBoundingClientRect();
          if (r.width > 300 && r.height > 300) { imageContainer = el; break; }
          el = el.parentElement;
        }
        if (!imageContainer) imageContainer = anchorImg.parentElement;
      }
    } else {
      imageContainer = document.querySelector(siteConfig.imageContainer);
    }

    // Generic fallback
    if (!imageContainer) {
      const imgs = Array.from(document.querySelectorAll("img"));
      const largeImg = imgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
      if (largeImg) imageContainer = largeImg.closest("div");
    }

    if (!imageContainer) {
      console.warn("[GeminiTryOnMe] No image container found for overlay.");
      return;
    }

    // Ensure relative positioning so absolute overlay works
    const containerStyle = window.getComputedStyle(imageContainer);
    if (containerStyle.position === "static") {
      imageContainer.style.position = "relative";
    }

    // Create overlay card
    const card = document.createElement("div");
    card.className = "nova-tryon-overlay-card";
    card.setAttribute("tabindex", "-1"); // Prevent Temu's autofocus management from interfering
    card.setAttribute("data-nova-tryon", "true"); // Mark as our element so Temu's React doesn't manage it
    card.innerHTML = `
      <div class="nova-tryon-overlay-header">
        <h3>Gemini TryOnMe Everything</h3>
        <button class="nova-tryon-overlay-close" aria-label="Close">&times;</button>
      </div>
      <div class="nova-tryon-overlay-body" inert>
        <div class="nova-tryon-loading">
          <div class="nova-tryon-spinner"></div>
          <div class="nova-tryon-loading-text">Generating your virtual try-on...</div>
          <div class="nova-tryon-loading-subtext">This may take a few seconds</div>
          <div class="nova-tryon-loading-timer" id="tryOnElapsedTimer">0.0s</div>
        </div>
      </div>
    `;

    imageContainer.appendChild(card);
    overlayCard = card;

    // Close handler — user explicitly closing = disable toggle
    const closeBtn = card.querySelector(".nova-tryon-overlay-close");
    closeBtn.addEventListener("click", () => closeOverlay(true));

    // Escape key closes overlay and disables toggle
    const escHandler = (e) => {
      if (e.key === "Escape") {
        closeOverlay(true);
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);

    // Start the try-on request
    performTryOn(card, photos, isCosmetic);
  }

  /**
   * Close the overlay card.
   * @param {boolean} disableToggle - If true, also turns off the try-on toggle (e.g. user clicked X).
   */
  function closeOverlay(disableToggle = false) {
    panelOpen = false;
    if (overlayCard) {
      overlayCard.remove();
      overlayCard = null;
    }
    // Clean up any open lightbox
    const lightbox = document.getElementById("nova-tryon-lightbox");
    if (lightbox) lightbox.remove();
    // Clear debug images from storage to free memory
    chrome.storage.local.remove(["tryOnDebug"]);
    if (disableToggle && tryOnEnabled) {
      tryOnEnabled = false;
      const btn = document.querySelector(".nova-tryon-btn");
      if (btn) {
        btn.classList.remove("nova-tryon-btn--active");
        btn.classList.add("nova-tryon-btn--pulse");
        btn.innerHTML = '<span class="nova-tryon-btn-icon">&#10024;</span> Try It On';
        const tooltip = document.createElement("div");
        tooltip.className = "nova-tryon-tooltip";
        tooltip.textContent = "Please upload your photos first";
        btn.appendChild(tooltip);
      }
      console.log("[GeminiTryOnMe] Try-on mode DISABLED (overlay closed by user)");
    }
  }

  // ---------------------------------------------------------------------------
  // Store debug images in chrome.storage so the popup panel can display them
  // ---------------------------------------------------------------------------
  function storeDebugImages(bodyPhotoBase64, garmentBase64, debugInfo) {
    const userPhoto = bodyPhotoBase64.startsWith("data:") ? bodyPhotoBase64 : "data:image/jpeg;base64," + bodyPhotoBase64;
    const garmentPhoto = garmentBase64.startsWith("data:") ? garmentBase64 : "data:image/jpeg;base64," + garmentBase64;

    // Estimate size — skip if images are too large (>4MB combined) to avoid quota pressure
    const estimatedBytes = (userPhoto.length + garmentPhoto.length) * 0.75;
    if (estimatedBytes > 4 * 1024 * 1024) {
      console.warn("[GeminiTryOnMe] Debug images too large, skipping storage");
      return;
    }

    // Remove previous debug data before writing new
    chrome.storage.local.remove("tryOnDebug", () => {
      chrome.storage.local.set({
        tryOnDebug: {
          userPhoto,
          garmentPhoto,
          garmentImageUsed: debugInfo.garmentImageUsed || "original",
          timestamp: Date.now(),
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Try-On API Request
  // ---------------------------------------------------------------------------
  // Shared helper: log backend debug steps to browser console
  function logDebugSteps(debug) {
    if (!debug || !debug.steps) return;
    const S = "background:#FF9900;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px;";
    const DESC = {
      "1": "Analyze the product image to detect garment type, color, and category",
      "2": "Check if the product image contains a person/model wearing the garment",
      "2.1": "Extract the garment from the model photo into a clean white-background image",
      "3": "Classify what the USER is currently wearing (top+bottom, dress, outerwear) to handle outfit conflicts",
      "4": "Determine try-on strategy and build the context-aware prompt for Gemini",
      "5": "Generate the final try-on image using AI image generation",
    };
    debug.steps.forEach((s) => {
      const desc = DESC[s.step] || "";
      const summary = s.result && s.result.error
        ? "FAILED: " + s.result.error
        : JSON.stringify(s.result).substring(0, 200);
      console.log(
        `%c STEP ${s.step}: ${s.name} %c [${s.model}] %c ${desc}`,
        S, "color:#4FC3F7;font-weight:bold;", "color:#aaa;font-style:italic;"
      );
      console.log(
        `%c   → %c ${summary} %c(${s.time})`,
        "color:#FF9900;font-weight:bold;", "color:#ccc;", "color:#888;"
      );
    });
    console.log(
      `%c PIPELINE COMPLETE %c Total: ${debug.totalTime} | Garment: ${debug.garmentImageUsed}`,
      "background:#4CAF50;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px;font-size:13px;",
      "color:#4CAF50;font-weight:bold;font-size:13px;"
    );
  }

  async function performTryOn(card, photos, isCosmetic) {
    const body = card && card.querySelector ? card.querySelector(".nova-tryon-overlay-body") : null;
    if (!body) {
      console.warn("[GeminiTryOnMe] performTryOn: no overlay body found, skipping.");
      return;
    }

    // Concurrency guard: each call gets an ID; if a newer call starts, older ones stop updating the UI
    const thisRequestId = ++tryOnRequestId;

    console.log(
      "%c 🔥 TRY-ON START %c " + (isCosmetic ? "COSMETIC" : "CLOTHING") + " (req#" + thisRequestId + ")",
      "background:#FF6600;color:#fff;font-weight:bold;padding:4px 8px;border-radius:4px;font-size:14px;",
      "color:#FF6600;font-weight:bold;font-size:14px;"
    );

    // Start elapsed timer
    const tryOnStart = Date.now();
    const timerEl = body.querySelector("#tryOnElapsedTimer");
    const timerInterval = setInterval(() => {
      if (timerEl) timerEl.textContent = ((Date.now() - tryOnStart) / 1000).toFixed(1) + "s";
    }, 1000);

    try {
      let resultImage;
      let debugInfo = null;

      // Read selected pose index (stored locally, backend fetches actual image from GCS)
      const currentPoseIdx = await new Promise((resolve) => {
        chrome.storage.local.get(["selectedPoseIndex"], (r) => resolve(r.selectedPoseIndex || 0));
      });

      // Guard: if analysisResult is null, re-analyze before proceeding
      if (!analysisResult && productImageBase64 && productData) {
        console.log("[GeminiTryOnMe] analysisResult is null, re-analyzing before try-on...");
        try {
          analysisResult = await ApiClient.analyzeProduct(
            productImageBase64,
            productData.title,
            productData.breadcrumbs
          );
          console.log("[GeminiTryOnMe] Re-analysis result:", analysisResult);
        } catch (err) {
          console.warn("[GeminiTryOnMe] Re-analysis failed:", err.message);
        }
      }

      if (isCosmetic) {
        const response = await ApiClient.tryOnCosmetics(
          photos.facePhoto,
          analysisResult.cosmeticType || "lipstick",
          analysisResult.color || null
        );
        resultImage = response.resultImage;
      } else if (currentIsAccessory) {
        const response = await ApiClient.tryOnAccessory(
          photos.facePhoto,
          productImageBase64,
          analysisResult.accessoryType || "earrings"
        );
        resultImage = response.resultImage;
      } else {
        // Send null as bodyImage so backend fetches the correct pose from GCS using poseIndex
        console.log(`[GeminiTryOnMe] Try-on params — poseIdx: ${currentPoseIdx}, framing: "${currentFraming}" (type: ${typeof currentFraming}), garmentClass: ${analysisResult ? analysisResult.garmentClass : 'null'}`);
        const response = await ApiClient.tryOn(
          null,
          productImageBase64,
          analysisResult ? analysisResult.garmentClass : null,
          "SEAMLESS",
          currentFraming,
          currentPoseIdx,
          productData ? productData.title : ""
        );
        resultImage = response.resultImage;
        debugInfo = response.debug;

        // Log all backend pipeline steps
        logDebugSteps(debugInfo);
      }

      // If a newer try-on was started while we were waiting, discard this result
      if (thisRequestId !== tryOnRequestId) {
        clearInterval(timerInterval);
        console.log(`[GeminiTryOnMe] Discarding stale try-on result (req#${thisRequestId}, current is req#${tryOnRequestId})`);
        return;
      }

      // Stop timer and compute elapsed
      clearInterval(timerInterval);
      const tryOnElapsed = ((Date.now() - tryOnStart) / 1000).toFixed(1);

      // Check if the result image is valid
      if (!resultImage) {
        console.error("[GeminiTryOnMe] No result image returned from API");
        body.removeAttribute("inert"); // Allow interaction with error UI
        body.innerHTML = `
          <div class="nova-tryon-error-msg">
            <p>No image was generated. Please try again.</p>
            <button class="nova-tryon-retry-btn" onclick="this.closest('.nova-tryon-overlay-card').querySelector('.nova-tryon-overlay-close').click()">Close</button>
          </div>`;
        return;
      }

      // If overlay card was detached from DOM (e.g. Temu React re-render), re-append it
      if (!card.isConnected) {
        console.warn("[GeminiTryOnMe] Overlay card was detached from DOM, re-appending...");
        const siteConfig = getSiteConfig();
        const host = window.location.hostname;
        let container = null;
        if (host.includes("temu.")) {
          const temuImgs = Array.from(document.querySelectorAll("img[src*='kwcdn.com'], img[src*='temu.com']"));
          const largeTemu = temuImgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
          const anchorImg = largeTemu || temuImgs[0];
          if (anchorImg) {
            let el = anchorImg.parentElement;
            for (let i = 0; i < 5 && el && el !== document.body; i++) {
              const r = el.getBoundingClientRect();
              if (r.width > 300 && r.height > 300) { container = el; break; }
              el = el.parentElement;
            }
            if (!container) container = anchorImg.parentElement;
          }
        } else {
          container = document.querySelector(siteConfig.imageContainer);
        }
        if (!container) {
          const imgs = Array.from(document.querySelectorAll("img"));
          const largeImg = imgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
          if (largeImg) container = largeImg.closest("div");
        }
        if (container) {
          const containerStyle = window.getComputedStyle(container);
          if (containerStyle.position === "static") container.style.position = "relative";
          container.appendChild(card);
          overlayCard = card;
        } else {
          console.error("[GeminiTryOnMe] Could not find container to re-append overlay");
        }
      }

      // Display the result (minimal overlay — controls are in the side panel)
      // Remove inert so buttons/interactions work now that result is ready
      body.removeAttribute("inert");
      const resultDataUrl = base64ToDataUrl(resultImage);
      body.innerHTML = `
        <div class="nova-tryon-result">
          <img src="${resultDataUrl}" alt="Virtual try-on result" style="cursor:pointer;" title="Click to enlarge" />
        </div>
        <div class="nova-tryon-elapsed">Generated in ${tryOnElapsed}s</div>
        ${analysisResult && analysisResult.styleTips ? `
          <div class="nova-tryon-style-tips">
            <div class="nova-tryon-style-tips-title">Style Tips</div>
            ${(Array.isArray(analysisResult.styleTips) ? analysisResult.styleTips : [analysisResult.styleTips])
              .map(t => `<div class="nova-tryon-style-tip">${String(t).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`)
              .join("")}
          </div>
        ` : ""}
        <div class="nova-tryon-action-row">
          <button class="nova-tryon-favorite-btn" data-product-id="${productData.productId || ''}">
            <span class="nova-tryon-favorite-icon">\u2661</span> Save to Favorites
          </button>
        </div>
        <div class="nova-tryon-share-row">
          <button class="nova-tryon-share-btn nova-tryon-share-download" title="Download image">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </button>
          <button class="nova-tryon-share-btn nova-tryon-share-copy" title="Copy to clipboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy
          </button>
          <button class="nova-tryon-share-btn nova-tryon-share-email" title="Share via email">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4l-10 8L2 4"/></svg>
            Email
          </button>
        </div>
        <button class="nova-tryon-animate-btn">
          &#9654; Animate
        </button>
      `;

      // After setting innerHTML, check AGAIN if card was detached (Temu React re-render race)
      if (!card.isConnected) {
        console.warn("[GeminiTryOnMe] Card detached during result render, re-appending...");
        const host = window.location.hostname;
        let reContainer = null;
        if (host.includes("temu.")) {
          const temuImgs = Array.from(document.querySelectorAll("img[src*='kwcdn.com'], img[src*='temu.com']"));
          const largeTemu = temuImgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
          const anchorImg = largeTemu || temuImgs[0];
          if (anchorImg) {
            let el = anchorImg.parentElement;
            for (let i = 0; i < 5 && el && el !== document.body; i++) {
              const r = el.getBoundingClientRect();
              if (r.width > 300 && r.height > 300) { reContainer = el; break; }
              el = el.parentElement;
            }
            if (!reContainer) reContainer = anchorImg.parentElement;
          }
        } else {
          const siteConfig = getSiteConfig();
          reContainer = document.querySelector(siteConfig.imageContainer);
        }
        if (!reContainer) {
          const imgs = Array.from(document.querySelectorAll("img"));
          const largeImg = imgs.find(img => { const r = img.getBoundingClientRect(); return r.width > 200 && r.height > 200; });
          if (largeImg) reContainer = largeImg.closest("div");
        }
        if (reContainer) {
          const cs = window.getComputedStyle(reContainer);
          if (cs.position === "static") reContainer.style.position = "relative";
          reContainer.appendChild(card);
          overlayCard = card;
        }
      }

      // Store debug images — fetch the actual pose used from backend
      if (debugInfo) {
        // Get the pose image the backend actually used (from GCS via poseIndex)
        let debugBodyPhoto = photos.bodyPhoto;
        try {
          const allPhotos = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
              type: "API_CALL", endpoint: "/api/profile/photos/all", method: "GET", data: {}
            }, (res) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              if (res && res.error) return reject(new Error(res.error));
              resolve(res?.data || res);
            });
          });
          if (allPhotos.generated && allPhotos.generated[currentPoseIdx]) {
            debugBodyPhoto = allPhotos.generated[currentPoseIdx];
          }
        } catch (_) {}
        storeDebugImages(debugBodyPhoto, productImageBase64, debugInfo);
      }

      // Favorites button handler
      const favBtn = body.querySelector(".nova-tryon-favorite-btn");
      if (favBtn) {
        favBtn.addEventListener("click", async () => {
          try {
            const authStatus = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage({ type: "GET_AUTH_STATUS" }, (res) => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                resolve(res && res.data ? res.data : { isAuthenticated: false });
              });
            });

            if (!authStatus.isAuthenticated) {
              showPageToast("Please sign in to save favorites.");
              return;
            }

            console.log("[GeminiTryOnMe] SAVE FAVORITE — productId:", productData.productId, "retailer:", productData.retailer);
            console.log("[GeminiTryOnMe]   productImage:", productData.imageUrl ? "YES (" + productData.imageUrl.substring(0, 60) + "...)" : "NO");
            console.log("[GeminiTryOnMe]   tryOnResultImage:", resultImage ? "YES (length=" + resultImage.length + ", starts=" + resultImage.substring(0, 30) + "...)" : "NO/EMPTY");

            const favResult = await ApiClient.addFavorite({
              productId: productData.productId || "",
              retailer: productData.retailer || "amazon",
              productTitle: productData.title || "",
              productImage: productData.imageUrl || "",
              productUrl: productData.productUrl || window.location.href,
              category: analysisResult ? analysisResult.category : "",
              garmentClass: analysisResult ? analysisResult.garmentClass : "",
              tryOnResultImage: resultImage,
            });
            console.log("[GeminiTryOnMe]   Save result:", JSON.stringify(favResult).substring(0, 200));

            favBtn.innerHTML = '<span class="nova-tryon-favorite-icon">\u2665</span> Saved!';
            favBtn.classList.add("nova-tryon-favorite-btn--saved");
            showPageToast("Added to favorites!");
          } catch (err) {
            console.error("[GeminiTryOnMe] Failed to save favorite:", err);
            showPageToast("Failed to save favorite: " + err.message);
          }
        });
      }

      // Share: Download
      const downloadBtn = body.querySelector(".nova-tryon-share-download");
      if (downloadBtn) {
        downloadBtn.addEventListener("click", () => {
          const a = document.createElement("a");
          a.href = resultDataUrl;
          a.download = `tryon_${productData.productId || "result"}_${Date.now()}.jpg`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
      }

      // Share: Copy to clipboard
      const copyBtn = body.querySelector(".nova-tryon-share-copy");
      if (copyBtn) {
        copyBtn.addEventListener("click", async () => {
          try {
            const resp = await fetch(resultDataUrl);
            const blob = await resp.blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            copyBtn.textContent = "Copied!";
            setTimeout(() => { copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy'; }, 2000);
          } catch (err) {
            console.error("[GeminiTryOnMe] Copy failed:", err);
            showPageToast("Failed to copy image to clipboard.");
          }
        });
      }

      // Share: Email
      const emailBtn = body.querySelector(".nova-tryon-share-email");
      if (emailBtn) {
        emailBtn.addEventListener("click", () => {
          showEmailShareDialog(resultImage, productData);
        });
      }

      // Animate button handler (generate video)
      const animateBtn = body.querySelector(".nova-tryon-animate-btn");
      animateBtn.addEventListener("click", () =>
        handleAnimate(body, resultImage, animateBtn)
      );

      // Lightbox: click result image to enlarge
      const resultImg = body.querySelector(".nova-tryon-result img");
      if (resultImg) {
        resultImg.addEventListener("click", () => openTryOnLightbox(resultDataUrl));
      }

    } catch (err) {
      clearInterval(timerInterval);
      body.removeAttribute("inert"); // Allow interaction with error UI
      console.error("%c ✗ TRY-ON FAILED %c " + err.message, "background:#f44336;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px;", "color:#f44336;font-weight:bold;");
      body.innerHTML = `
        <div class="nova-tryon-error">
          <div class="nova-tryon-error-icon">&#9888;</div>
          <div class="nova-tryon-error-text">Something went wrong</div>
          <div class="nova-tryon-error-detail">${String(err.message).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
          <button class="nova-tryon-retry-btn">Try Again</button>
        </div>
      `;

      // Retry handler
      const retryBtn = body.querySelector(".nova-tryon-retry-btn");
      if (retryBtn) {
        retryBtn.addEventListener("click", () => {
          body.innerHTML = `
            <div class="nova-tryon-loading">
              <div class="nova-tryon-spinner"></div>
              <div class="nova-tryon-loading-text">Retrying...</div>
            </div>
          `;
          performTryOn(card, photos, isCosmetic);
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Variation/Color Change Detection — Polling Watchdog
  // ---------------------------------------------------------------------------
  let watchdogInterval = null;
  let watchdogBusy = false; // Prevents overlapping async work

  /**
   * Start a simple setInterval watchdog that:
   *  (a) Re-injects the button if Amazon destroyed it
   *  (b) Detects image URL changes and auto-triggers try-on when enabled
   *
   * This replaces MutationObserver which proved unreliable against Amazon's
   * aggressive Twister DOM rebuilds.
   */
  let lastPageUrl = null; // Track page URL for navigation detection

  function setupVariationObserver() {
    lastImageUrl = productData.imageUrl;
    lastPageUrl = location.href;

    watchdogInterval = setInterval(() => {
      // (c) Check for page URL change (SPA navigation to new product)
      const currentPageUrl = location.href;
      if (currentPageUrl !== lastPageUrl && !watchdogBusy) {
        console.log("[GeminiTryOnMe] Watchdog: PAGE URL CHANGED");
        console.log("[GeminiTryOnMe]   old URL:", lastPageUrl);
        console.log("[GeminiTryOnMe]   new URL:", currentPageUrl);
        lastPageUrl = currentPageUrl;
        handlePageNavigation();
      }

      // (a) Ensure button is always present
      if (!document.querySelector(".nova-tryon-btn")) {
        console.log("[GeminiTryOnMe] Watchdog: button missing, re-injecting...");
        injectTryOnButton(); // This already adds handleTryOnClick listener
        // Restore active state if toggle is ON
        if (tryOnEnabled) {
          const newBtn = document.querySelector(".nova-tryon-btn");
          if (newBtn) {
            newBtn.classList.add("nova-tryon-btn--active");
            newBtn.classList.remove("nova-tryon-btn--pulse");
            newBtn.innerHTML = '<span class="nova-tryon-btn-icon">&#10024;</span> Try On: ON';
            const tooltip = document.createElement("div");
            tooltip.className = "nova-tryon-tooltip";
            tooltip.textContent = "Click to disable auto try-on";
            newBtn.appendChild(tooltip);
            // NOTE: Do NOT add another click listener — injectTryOnButton already did
          }
        }
      }

      // (b) Check for image URL change
      const newUrl = scrapeCurrentImageUrl();
      if (newUrl && newUrl !== lastImageUrl && !watchdogBusy) {
        console.log("[GeminiTryOnMe] Watchdog: IMAGE CHANGED");
        console.log("[GeminiTryOnMe]   old URL:", lastImageUrl?.substring(0, 80) + "...");
        console.log("[GeminiTryOnMe]   new URL:", newUrl.substring(0, 80) + "...");
        console.log("[GeminiTryOnMe]   tryOnEnabled:", tryOnEnabled);
        console.log("[GeminiTryOnMe]   panelOpen:", panelOpen);
        lastImageUrl = newUrl;
        productData.imageUrl = newUrl;

        if (tryOnEnabled) {
          handleVariationChange(newUrl);
        }
      }
    }, 500);

    console.log("[GeminiTryOnMe] Watchdog polling active (500ms).");
  }

  /**
   * Handle a detected variation/color change when try-on is enabled.
   */
  async function handleVariationChange(newUrl) {
    console.log("[GeminiTryOnMe] === VARIATION CHANGE HANDLER ===");
    console.log("[GeminiTryOnMe]   newUrl:", newUrl.substring(0, 80) + "...");
    console.log("[GeminiTryOnMe]   tryOnEnabled:", tryOnEnabled);
    console.log("[GeminiTryOnMe]   panelOpen:", panelOpen);
    console.log("[GeminiTryOnMe]   hasOverlayCard:", !!overlayCard);
    console.log("[GeminiTryOnMe]   hasCurrentPhotos:", !!currentPhotos);
    watchdogBusy = true;

    // Re-fetch the new product image
    try {
      console.log("[GeminiTryOnMe]   → Fetching new product image...");
      productImageBase64 = await fetchImageAsBase64(newUrl);
      console.log("[GeminiTryOnMe]   → Fetched, base64 length:", productImageBase64.length);
    } catch (err) {
      console.error("[GeminiTryOnMe] Failed to fetch new variation image:", err);
      watchdogBusy = false;
      return;
    }

    // Re-analyze the product
    try {
      console.log("[GeminiTryOnMe]   → Re-analyzing product with Gemini classifier...");
      analysisResult = await ApiClient.analyzeProduct(
        productImageBase64,
        productData.title,
        productData.breadcrumbs
      );
      console.log("[GeminiTryOnMe]   → Analysis result:", JSON.stringify(analysisResult));
    } catch (err) {
      console.warn("[GeminiTryOnMe] Re-analysis failed:", err.message);
      // Analysis failed — don't proceed with try-on using stale/null data
      watchdogBusy = false;
      return;
    }

    // Auto-refresh the try-on overlay
    console.log("[GeminiTryOnMe]   → Checking overlay state: panelOpen=%s, overlayCard=%s, currentPhotos=%s", panelOpen, !!overlayCard, !!currentPhotos);
    if (panelOpen && overlayCard && currentPhotos && analysisResult) {
      const body = overlayCard.querySelector(".nova-tryon-overlay-body");
      if (body) {
        body.innerHTML = `
          <div class="nova-tryon-loading">
            <div class="nova-tryon-spinner"></div>
            <div class="nova-tryon-loading-text">Updating with new color...</div>
            <div class="nova-tryon-loading-subtext">This may take a few seconds</div>
            <div class="nova-tryon-loading-timer" id="tryOnElapsedTimer">0.0s</div>
          </div>
        `;
        performTryOn(overlayCard, currentPhotos, currentIsCosmetic);
      }
    } else if (!panelOpen && currentPhotos) {
      // Overlay was closed but toggle is still ON — re-open it
      openOverlay(currentPhotos, currentIsCosmetic);
    }

    watchdogBusy = false;
  }

  /**
   * Handle page navigation (SPA-style URL change on Amazon).
   * Re-scrapes product data and auto-triggers try-on if enabled.
   */
  async function handlePageNavigation() {
    watchdogBusy = true;
    console.log("[GeminiTryOnMe] === PAGE NAVIGATION HANDLER ===");

    // Re-scrape the new product page
    const newProductData = scrapeProductData();
    if (!newProductData.imageUrl) {
      console.warn("[GeminiTryOnMe] New page has no product image, skipping.");
      watchdogBusy = false;
      return;
    }

    productData = newProductData;
    lastImageUrl = productData.imageUrl;
    console.log("[GeminiTryOnMe]   New product:", productData.title);

    // Re-fetch the product image
    try {
      productImageBase64 = await fetchImageAsBase64(productData.imageUrl);
    } catch (err) {
      console.error("[GeminiTryOnMe] Failed to fetch new product image:", err);
      watchdogBusy = false;
      return;
    }

    // Re-analyze the product
    try {
      analysisResult = await ApiClient.analyzeProduct(
        productImageBase64,
        productData.title,
        productData.breadcrumbs
      );
      console.log("[GeminiTryOnMe]   Analysis result:", JSON.stringify(analysisResult));
    } catch (err) {
      console.warn("[GeminiTryOnMe] Product analysis failed:", err.message);
    }

    // Re-inject button if needed (new page may not have it)
    if (!document.querySelector(".nova-tryon-btn")) {
      injectTryOnButton();
    }

    // Auto-trigger try-on if enabled
    if (tryOnEnabled && currentPhotos) {
      const isCosmetic =
        analysisResult &&
        analysisResult.category &&
        analysisResult.category.toLowerCase().includes("cosmetic");
      const isAccessory =
        analysisResult &&
        analysisResult.category &&
        analysisResult.category.toLowerCase() === "accessories" &&
        !!analysisResult.accessoryType;
      currentIsCosmetic = isCosmetic;
      currentIsAccessory = isAccessory;

      // Close existing overlay and open fresh one
      if (panelOpen && overlayCard) {
        overlayCard.remove();
        overlayCard = null;
        panelOpen = false;
      }
      openOverlay(currentPhotos, isCosmetic);
    }

    watchdogBusy = false;
  }

  // ---------------------------------------------------------------------------
  // Video Animation (Grok Imagine Video)
  // ---------------------------------------------------------------------------
  async function handleAnimate(body, resultImage, btn) {
    btn.disabled = true;
    btn.textContent = "Generating video... 0s";

    const videoStart = Date.now();
    const videoTimerInterval = setInterval(() => {
      const elapsed = ((Date.now() - videoStart) / 1000).toFixed(0);
      btn.textContent = `Generating video... ${elapsed}s`;
    }, 1000);

    try {
      const response = await ApiClient.generateVideo(resultImage);
      const jobId = response.jobId;
      const videoProvider = response.provider || "grok";

      // Poll for video completion
      const videoResult = await pollVideoStatus(jobId, videoProvider);

      clearInterval(videoTimerInterval);
      const videoElapsed = ((Date.now() - videoStart) / 1000).toFixed(1);

      // Display the video
      const videoContainer = document.createElement("div");
      videoContainer.className = "nova-tryon-video-container";
      const videoSrc = videoResult.videoBase64
        ? `data:${videoResult.videoMimeType || "video/mp4"};base64,${videoResult.videoBase64}`
        : videoResult.videoUrl;
      videoContainer.innerHTML = `
        <video class="nova-tryon-video" controls autoplay loop>
          <source src="${videoSrc}" type="video/mp4" />
          Your browser does not support the video tag.
        </video>
        <div class="nova-tryon-video-actions">
          <span class="nova-tryon-elapsed">Video generated in ${videoElapsed}s</span>
          <div class="nova-tryon-video-btns">
            <button class="nova-tryon-save-video-btn" title="Save to your account">Save</button>
            <button class="nova-tryon-download-video-btn" title="Download to your computer">Download</button>
          </div>
        </div>
      `;

      // Wire Save button (upload to GCS)
      const saveBtn = videoContainer.querySelector(".nova-tryon-save-video-btn");
      saveBtn.addEventListener("click", async () => {
        saveBtn.textContent = "Saving...";
        saveBtn.disabled = true;
        try {
          const pId = productData?.productId || "";
          await ApiClient.saveVideo(
            videoResult.videoUrl || null,
            videoResult.videoBase64 || null,
            pId,
            productData?.title || "",
            productData?.imageUrl || "",
            productData?.retailer || "amazon"
          );
          saveBtn.textContent = "Saved!";
          showPageToast("Video saved to your account!");
        } catch (err) {
          console.error("[GeminiTryOnMe] Failed to save video:", err);
          saveBtn.textContent = "Failed";
          showPageToast("Failed to save video: " + err.message);
          setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.disabled = false; }, 2000);
        }
      });

      // Wire Download button (local download via blob to avoid cross-origin navigation)
      const downloadBtn = videoContainer.querySelector(".nova-tryon-download-video-btn");
      downloadBtn.addEventListener("click", async () => {
        downloadBtn.textContent = "Downloading...";
        downloadBtn.disabled = true;
        try {
          const resp = await fetch(videoSrc);
          const blob = await resp.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = "tryon-video-" + Date.now() + ".mp4";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
          downloadBtn.textContent = "Download";
          downloadBtn.disabled = false;
        } catch (err) {
          console.error("[GeminiTryOnMe] Download failed:", err);
          downloadBtn.textContent = "Failed";
          setTimeout(() => { downloadBtn.textContent = "Download"; downloadBtn.disabled = false; }, 2000);
        }
      });

      body.appendChild(videoContainer);
      btn.textContent = "\u25B6 Animate";
      btn.disabled = false;
    } catch (err) {
      clearInterval(videoTimerInterval);
      console.error("[GeminiTryOnMe] Video generation failed:", err);
      btn.textContent = "\u25B6 Animate";
      btn.disabled = false;
      const errorDiv = document.createElement("div");
      errorDiv.className = "nova-tryon-error";
      errorDiv.textContent = `Video generation failed: ${err.message}`;
      body.appendChild(errorDiv);
    }
  }

  /**
   * Poll the backend for video generation status until complete or failed.
   * @param {string} jobId - The video generation job ID
   * @returns {Promise<string>} URL of the completed video
   */
  // Active abort controller for video polling — allows cancellation on navigation
  let _videoPollAbort = null;

  async function pollVideoStatus(jobId, provider) {
    const MAX_POLLS = 40;
    const BASE_INTERVAL = 3000; // 3s initial
    const MAX_INTERVAL = 15000; // cap at 15s

    // Abort any previous polling
    if (_videoPollAbort) _videoPollAbort.abort();
    _videoPollAbort = new AbortController();
    const signal = _videoPollAbort.signal;

    for (let i = 0; i < MAX_POLLS; i++) {
      // Exponential backoff: 3s, 4.5s, 6.75s, ... capped at 15s
      const delay = Math.min(BASE_INTERVAL * Math.pow(1.5, i), MAX_INTERVAL);
      await new Promise((r) => setTimeout(r, delay));

      if (signal.aborted) throw new Error("Video polling aborted");

      const status = await ApiClient.getVideoStatus(jobId, provider);

      if ((status.status === "Completed" || status.status === "COMPLETED") && (status.videoUrl || status.videoBase64)) {
        _videoPollAbort = null;
        return status;
      }
      if (status.status === "Failed" || status.status === "FAILED") {
        _videoPollAbort = null;
        throw new Error(status.failureMessage || status.error || "Video generation failed");
      }
      // Otherwise keep polling (IN_PROGRESS)
    }

    _videoPollAbort = null;
    throw new Error("Video generation timed out");
  }

  // ---------------------------------------------------------------------------
  // Email Share Dialog
  // ---------------------------------------------------------------------------
  function showEmailShareDialog(resultImageBase64, product) {
    // Remove existing dialog
    const existing = document.getElementById("nova-tryon-email-dialog");
    if (existing) existing.remove();

    const dialog = document.createElement("div");
    dialog.id = "nova-tryon-email-dialog";
    dialog.className = "nova-tryon-email-dialog-overlay";
    dialog.innerHTML = `
      <div class="nova-tryon-email-dialog">
        <div class="nova-tryon-email-dialog-header">
          <h3>Share Try-On Result</h3>
          <button class="nova-tryon-email-dialog-close">&times;</button>
        </div>
        <div class="nova-tryon-email-dialog-body">
          <div class="nova-tryon-email-preview">
            <img src="${base64ToDataUrl(resultImageBase64)}" alt="Try-on preview" />
          </div>
          <button class="nova-tryon-email-self-btn">Send to myself</button>
          <div class="nova-tryon-email-field">
            <label>Recipient Email</label>
            <input type="email" class="nova-tryon-email-input" placeholder="friend@example.com" />
          </div>
          <div class="nova-tryon-email-field">
            <label>Message (optional)</label>
            <textarea class="nova-tryon-email-message" rows="2" placeholder="Check out how this looks on me!"></textarea>
          </div>
          <div class="nova-tryon-email-error" style="display:none;"></div>
          <button class="nova-tryon-email-send-btn">Send Email</button>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);

    // "Send to myself" — auto-fill with the logged-in user's email
    const selfBtn = dialog.querySelector(".nova-tryon-email-self-btn");
    chrome.storage.local.get(["userEmail"], (result) => {
      if (result.userEmail) {
        selfBtn.addEventListener("click", () => {
          dialog.querySelector(".nova-tryon-email-input").value = result.userEmail;
          selfBtn.textContent = "Filled!";
          selfBtn.disabled = true;
        });
      } else {
        selfBtn.style.display = "none";
      }
    });

    // Close handlers
    dialog.querySelector(".nova-tryon-email-dialog-close").addEventListener("click", () => dialog.remove());
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.remove(); });

    // Send handler
    dialog.querySelector(".nova-tryon-email-send-btn").addEventListener("click", async () => {
      const emailInput = dialog.querySelector(".nova-tryon-email-input");
      const messageInput = dialog.querySelector(".nova-tryon-email-message");
      const errorEl = dialog.querySelector(".nova-tryon-email-error");
      const sendBtn = dialog.querySelector(".nova-tryon-email-send-btn");
      const recipientEmail = emailInput.value.trim();

      if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
        errorEl.textContent = "Please enter a valid email address.";
        errorEl.style.display = "block";
        return;
      }

      sendBtn.disabled = true;
      sendBtn.textContent = "Sending...";
      errorEl.style.display = "none";

      try {
        await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: "SHARE_EMAIL",
            recipientEmail,
            message: messageInput.value.trim(),
            resultImage: resultImageBase64,
            productTitle: product.title || "",
          }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (res && res.error) return reject(new Error(res.error));
            resolve(res?.data || res);
          });
        });
        sendBtn.textContent = "Sent!";
        sendBtn.style.background = "#00C853";
        setTimeout(() => dialog.remove(), 1500);
      } catch (err) {
        errorEl.textContent = err.message || "Failed to send email.";
        errorEl.style.display = "block";
        sendBtn.disabled = false;
        sendBtn.textContent = "Send Email";
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Lightbox for try-on result image
  // ---------------------------------------------------------------------------
  function openTryOnLightbox(imageSrc) {
    // Remove existing lightbox if any
    const existing = document.getElementById("nova-tryon-lightbox");
    if (existing) existing.remove();

    const lightbox = document.createElement("div");
    lightbox.id = "nova-tryon-lightbox";
    lightbox.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:100000;display:flex;align-items:center;justify-content:center;";

    lightbox.innerHTML = `
      <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);" data-close="1"></div>
      <div style="position:relative;max-width:90%;max-height:90%;">
        <img src="${imageSrc}" style="max-width:100%;max-height:85vh;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.5);display:block;" alt="Try-on result full size" />
        <button style="position:absolute;top:-12px;right:-12px;width:32px;height:32px;border-radius:50%;border:none;background:#fff;color:#333;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);" data-close="1">&times;</button>
      </div>
    `;

    // Close on backdrop/button click
    lightbox.addEventListener("click", (e) => {
      if (e.target.dataset.close === "1" || e.target.closest("[data-close='1']")) {
        lightbox.remove();
      }
    });

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === "Escape") {
        lightbox.remove();
        document.removeEventListener("keydown", escHandler);
      }
    };
    document.addEventListener("keydown", escHandler);

    document.body.appendChild(lightbox);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  init();
})();
