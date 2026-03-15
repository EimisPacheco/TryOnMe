/**
 * GeminiTryOnMe - Smart Search Results Page
 *
 * Receives search query via URL params, calls backend via background.js,
 * displays product grid, and enables virtual try-on for each product.
 *
 * Uses the same ApiClient class as the Focused Product Page (content.js)
 * to ensure identical pipeline behavior.
 *
 * NOTE: No inline event handlers (onclick) — Chrome extension CSP forbids them.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let searchStartTime = 0;
let timerInterval = null;
let tryOnTimerInterval = null;
let tryOnStartTime = 0;
let currentPoseIndex = 0;

// Non-blocking toast notification
function showPageToast(msg, duration = 3500) {
  let toast = document.getElementById('nova-search-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'nova-search-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:#1a1a2e;color:#fff;padding:12px 24px;border-radius:12px;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.3);transition:transform 0.3s ease,opacity 0.3s ease;opacity:0;max-width:400px;text-align:center;border:1px solid rgba(196,75,255,0.3);';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
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
let currentFraming = 'full';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const params = new URLSearchParams(window.location.search);
const rawQuery = params.get("q") || "";
const clothesSize = params.get("clothesSize") || "";
const shoesSize = params.get("shoesSize") || "";
const userSex = params.get("sex") || "";

// Build enriched query with user's size preferences
let query = rawQuery;
if (query) {
  const sizeParts = [];
  // Add sex-appropriate suffix if not already in query
  if (userSex && !query.toLowerCase().includes("for men") && !query.toLowerCase().includes("for women")) {
    sizeParts.push(userSex === "male" ? "for men" : "for women");
  }
  // Add clothes size for apparel queries (skip if query is clearly about shoes only)
  const isShoeQuery = /\bshoes?\b|\bsneakers?\b|\bboots?\b|\bsandals?\b|\bheels?\b/i.test(query);
  if (clothesSize && !isShoeQuery) {
    sizeParts.push(`size ${clothesSize}`);
  }
  if (shoesSize && isShoeQuery) {
    sizeParts.push(`size ${shoesSize}`);
  }
  if (sizeParts.length) {
    query = `${rawQuery} ${sizeParts.join(" ")}`;
  }
}

document.getElementById("searchQuery").textContent = rawQuery
  ? `Results for: "${rawQuery}"`
  : "Smart Search";

// Wire up non-inline event listeners
document.getElementById("errorCloseBtn").addEventListener("click", () => window.close());
document.getElementById("modalCloseBtn").addEventListener("click", closeTryOnModal);
document.getElementById("tryOnModal").addEventListener("click", (e) => {
  if (
    e.target.id === "tryOnModal" ||
    e.target.classList.contains("nova-modal-close") ||
    e.target.closest(".nova-modal-close")
  ) {
    closeTryOnModal();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTryOnModal();
});

// Load pose/framing from storage (same as content.js)
chrome.storage.local.get(["selectedPoseIndex", "tryOnFraming"], (stored) => {
  if (stored.selectedPoseIndex !== undefined) currentPoseIndex = stored.selectedPoseIndex;
  if (stored.tryOnFraming) currentFraming = stored.tryOnFraming;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.selectedPoseIndex) currentPoseIndex = changes.selectedPoseIndex.newValue || 0;
  if (changes.tryOnFraming) currentFraming = changes.tryOnFraming.newValue || "full";
});

if (query) {
  startSearch(query);
} else {
  showError("No search query provided.");
}

// ---------------------------------------------------------------------------
// Search Timer
// ---------------------------------------------------------------------------
function startTimer() {
  searchStartTime = Date.now();
  const timerEl = document.getElementById("searchTimer");
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - searchStartTime) / 1000);
    timerEl.textContent = `Elapsed: ${elapsed}s`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  return Math.floor((Date.now() - searchStartTime) / 1000);
}

// ---------------------------------------------------------------------------
// Search (uses ApiClient._sendMessage for SMART_SEARCH which has no wrapper)
// ---------------------------------------------------------------------------
async function startSearch(q) {
  showLoading();
  startTimer();
  try {
    const result = await ApiClient._sendMessage({
      type: "SMART_SEARCH",
      query: q,
    });

    const elapsedSeconds = stopTimer();

    if (!result || result.error) {
      showError(result?.error || "Search failed. Please try again.");
      return;
    }

    const products = result.products || [];
    if (products.length === 0) {
      showError("No products found. Try a different search query.");
      return;
    }

    renderResults(products, elapsedSeconds);
  } catch (err) {
    stopTimer();
    console.error("[SmartSearch] Error:", err);
    showError(err.message || "An unexpected error occurred.");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function showLoading() {
  document.getElementById("loadingState").hidden = false;
  document.getElementById("errorState").hidden = true;
  document.getElementById("resultsGrid").hidden = true;
}

function showError(message) {
  document.getElementById("loadingState").hidden = true;
  document.getElementById("errorState").hidden = false;
  document.getElementById("resultsGrid").hidden = true;
  document.getElementById("errorMessage").textContent = message;
}

function renderResults(products, elapsedSeconds) {
  document.getElementById("loadingState").hidden = true;
  document.getElementById("errorState").hidden = true;
  document.getElementById("resultsGrid").hidden = false;

  document.getElementById("resultCount").textContent =
    `${products.length} product${products.length !== 1 ? "s" : ""} found`;

  if (elapsedSeconds !== undefined) {
    const timeEl = document.getElementById("searchTime");
    const mins = Math.floor(elapsedSeconds / 60);
    const secs = elapsedSeconds % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    timeEl.textContent = `Found in ${timeStr}`;
  }

  const grid = document.getElementById("productGrid");
  grid.innerHTML = "";

  products.forEach((product, index) => {
    grid.appendChild(createProductCard(product, index));
  });
}

function createProductCard(product, index) {
  const card = document.createElement("div");
  card.className = "nova-card";
  card.dataset.product = JSON.stringify(product);

  // Image container with number badge
  const imgWrap = document.createElement("div");
  imgWrap.className = "nova-card-image-wrap";
  imgWrap.style.position = "relative";

  const numberBadge = document.createElement("span");
  numberBadge.className = "nova-card-number";
  numberBadge.textContent = index + 1;
  imgWrap.appendChild(numberBadge);

  const img = document.createElement("img");
  img.className = "nova-card-image";
  // Only set src if we have a valid image URL
  if (product.image_url && product.image_url.startsWith("http")) {
    img.src = product.image_url;
  } else {
    // Use retailer favicon as minimal fallback
    try {
      const prodUrl = new URL(product.product_url);
      img.src = `https://www.google.com/s2/favicons?domain=${prodUrl.hostname}&sz=128`;
    } catch (_) {
      img.src = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect fill="#f5f5f5" width="200" height="200"/><text x="50%" y="45%" text-anchor="middle" fill="#bbb" font-size="48">&#128722;</text><text x="50%" y="65%" text-anchor="middle" fill="#999" font-size="12">Product Image</text></svg>'
      );
    }
  }
  img.alt = product.title;
  img.addEventListener("error", function () {
    this.src =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect fill="#f5f5f5" width="200" height="200"/><text x="50%" y="45%" text-anchor="middle" fill="#bbb" font-size="48">&#128722;</text><text x="50%" y="65%" text-anchor="middle" fill="#999" font-size="12">Product Image</text></svg>'
      );
  });
  imgWrap.appendChild(img);
  card.appendChild(imgWrap);

  const body = document.createElement("div");
  body.className = "nova-card-body";

  const titleDiv = document.createElement("div");
  titleDiv.className = "nova-card-title";
  const titleLink = document.createElement("a");
  titleLink.href = product.product_url;
  titleLink.target = "_blank";
  titleLink.rel = "noopener";
  titleLink.textContent = product.title;
  titleDiv.appendChild(titleLink);
  body.appendChild(titleDiv);

  if (product.rating) {
    const ratingDiv = document.createElement("div");
    ratingDiv.className = "nova-card-rating";
    const starsSpan = document.createElement("span");
    starsSpan.className = "nova-card-stars";
    starsSpan.textContent = renderStars(product.rating);
    ratingDiv.appendChild(starsSpan);
    const ratingText = document.createElement("span");
    ratingText.textContent = product.rating;
    ratingDiv.appendChild(ratingText);
    body.appendChild(ratingDiv);
  }

  if (product.review_count) {
    const popDiv = document.createElement("div");
    popDiv.className = "nova-card-popularity";
    popDiv.textContent = product.review_count + " in past month";
    body.appendChild(popDiv);
  }

  if (product.price) {
    const priceDiv = document.createElement("div");
    priceDiv.className = "nova-card-price";
    priceDiv.textContent = product.price;
    body.appendChild(priceDiv);
  }

  const actionsDiv = document.createElement("div");
  actionsDiv.className = "nova-card-actions";

  const tryOnBtn = document.createElement("button");
  tryOnBtn.className = "nova-btn nova-btn-primary";
  tryOnBtn.dataset.index = index;
  tryOnBtn.innerHTML = "&#10024; Try On";
  tryOnBtn.addEventListener("click", () => handleTryOn(index));
  actionsDiv.appendChild(tryOnBtn);

  const buyLink = document.createElement("a");
  buyLink.className = "nova-btn nova-btn-secondary";
  buyLink.href = product.product_url;
  buyLink.target = "_blank";
  buyLink.rel = "noopener";
  buyLink.textContent = "Buy";
  actionsDiv.appendChild(buyLink);

  body.appendChild(actionsDiv);
  card.appendChild(body);
  return card;
}

function renderStars(rating) {
  const num = parseFloat(rating) || 0;
  const full = Math.floor(num);
  const half = num - full >= 0.3 ? 1 : 0;
  const empty = 5 - full - half;
  return "\u2605".repeat(full) + (half ? "\u00BD" : "") + "\u2606".repeat(empty);
}

// ---------------------------------------------------------------------------
// Try-On — mirrors content.js performTryOn() using identical ApiClient calls
// ---------------------------------------------------------------------------

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timed out")), ms)
    ),
  ]);
}

function startTryOnTimer() {
  tryOnStartTime = Date.now();
  const timerEl = document.getElementById("tryOnTimer");
  if (timerEl) timerEl.textContent = "0s";
  tryOnTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - tryOnStartTime) / 1000);
    if (timerEl) timerEl.textContent = `${elapsed}s`;
  }, 1000);
}

function stopTryOnTimer() {
  if (tryOnTimerInterval) {
    clearInterval(tryOnTimerInterval);
    tryOnTimerInterval = null;
  }
}

function updateTryOnStatus(step, message) {
  console.log(
    `%c STEP ${step} %c ${message}`,
    "background:#FF9900;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px;",
    "color:#FF9900;font-weight:bold;"
  );
  const statusEl = document.getElementById("tryOnStatus");
  if (statusEl) statusEl.textContent = message;
}

// Same logDebugSteps as content.js
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

// Same storeDebugImages as content.js
function storeDebugImages(bodyPhotoBase64, garmentBase64, debugInfo) {
  const userPhoto = bodyPhotoBase64.startsWith("data:") ? bodyPhotoBase64 : "data:image/jpeg;base64," + bodyPhotoBase64;
  const garmentPhoto = garmentBase64.startsWith("data:") ? garmentBase64 : "data:image/jpeg;base64," + garmentBase64;
  chrome.storage.local.set({
    tryOnDebug: {
      userPhoto,
      garmentPhoto,
      garmentImageUsed: debugInfo.garmentImageUsed || "original",
      timestamp: Date.now(),
    }
  });
}

async function handleTryOn(index) {
  const card = document.querySelectorAll(".nova-card")[index];
  if (!card) return;

  const product = JSON.parse(card.dataset.product);
  const btn = card.querySelector(".nova-btn-primary");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "\u23F3 Processing...";
  }

  try {
    // Step 1: Get user's body photo — same as content.js
    updateTryOnStatus(1, "Loading your photo...");
    const photos = await withTimeout(
      ApiClient._sendMessage({ type: "GET_USER_PHOTOS" }),
      5000
    );

    if (!photos || !photos.bodyPhoto) {
      showPageToast(
        "Please upload your body photo first! Open the extension panel and complete your profile setup."
      );
      return;
    }

    showTryOnModal();
    startTryOnTimer();

    // Step 2: Fetch product image as base64 — same as content.js fetchImageAsBase64
    updateTryOnStatus(2, "Fetching product image...");
    const garmentBase64 = await withTimeout(
      ApiClient._sendMessage({ type: "PROXY_IMAGE", url: product.image_url }),
      15000
    );

    if (!garmentBase64) {
      throw new Error("Failed to fetch product image");
    }

    // Step 3: Analyze product — same as content.js ApiClient.analyzeProduct()
    updateTryOnStatus(3, "Analyzing product...");
    let analysisResult = null;
    try {
      analysisResult = await withTimeout(
        ApiClient.analyzeProduct(garmentBase64, product.title || "", ""),
        15000
      );
      console.log("[SmartSearch] Product analysis:", JSON.stringify(analysisResult));
    } catch (err) {
      console.warn("[SmartSearch] Product analysis failed, proceeding without garmentClass:", err.message);
    }

    // Step 4: Call try-on pipeline — identical to content.js ApiClient.tryOn()
    updateTryOnStatus(4, "AI pipeline running (5 steps)...");
    console.log(`[SmartSearch] Try-on params — poseIdx: ${currentPoseIndex}, framing: ${currentFraming}, garmentClass: ${analysisResult ? analysisResult.garmentClass : 'null'}`);

    const response = await withTimeout(
      ApiClient.tryOn(
        null,                                              // bodyImage = null → backend fetches from S3
        garmentBase64,                                     // garment image
        analysisResult ? analysisResult.garmentClass : null, // garmentClass from analysis
        "SEAMLESS",                                        // mergeStyle
        currentFraming,                                    // framing from side panel
        currentPoseIndex,                                  // poseIndex from side panel
        product.title || ""                                // productTitle for classifier
      ),
      180000
    );

    const resultImage = response.resultImage;
    const debugInfo = response.debug;

    // Log all backend pipeline steps — same as content.js
    logDebugSteps(debugInfo);

    stopTryOnTimer();

    if (resultImage) {
      // Store debug images for side panel — same as content.js
      if (debugInfo) {
        let debugBodyPhoto = photos.bodyPhoto;
        try {
          const allPhotos = await ApiClient._sendMessage({
            type: "API_CALL", endpoint: "/api/profile/photos/all", method: "GET", data: {}
          });
          if (allPhotos.generated && allPhotos.generated[currentPoseIndex]) {
            debugBodyPhoto = allPhotos.generated[currentPoseIndex];
          }
        } catch (_) {}
        storeDebugImages(debugBodyPhoto, garmentBase64, debugInfo);
      }
      showTryOnResult(resultImage, product);
    } else {
      throw new Error(response?.error || "Try-on failed — no result image returned");
    }
  } catch (err) {
    stopTryOnTimer();
    console.error(`%c ✗ TRY-ON FAILED %c ${err.message}`, "background:#f44336;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px;", "color:#f44336;font-weight:bold;");
    closeTryOnModal();
    showPageToast("Try-on failed: " + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "&#10024; Try On";
    }
  }
}

// ---------------------------------------------------------------------------
// Try-On Modal
// ---------------------------------------------------------------------------
function showTryOnModal() {
  const modal = document.getElementById("tryOnModal");
  const body = document.getElementById("tryOnModalBody");
  modal.hidden = false;
  body.innerHTML = "";

  const loadingDiv = document.createElement("div");
  loadingDiv.className = "nova-loading";

  const spinner = document.createElement("div");
  spinner.className = "nova-loading-spinner";
  loadingDiv.appendChild(spinner);

  const msg = document.createElement("p");
  msg.id = "tryOnStatus";
  msg.textContent = "Preparing virtual try-on...";
  loadingDiv.appendChild(msg);

  const hint = document.createElement("p");
  hint.className = "nova-loading-hint";
  hint.textContent = "This may take 15-30 seconds";
  loadingDiv.appendChild(hint);

  const timer = document.createElement("p");
  timer.className = "nova-loading-timer";
  timer.id = "tryOnTimer";
  timer.textContent = "0s";
  loadingDiv.appendChild(timer);

  body.appendChild(loadingDiv);
}

function showTryOnResult(base64Image, product) {
  const body = document.getElementById("tryOnModalBody");
  body.innerHTML = "";
  const title = product.title || "";

  // Result image
  const img = document.createElement("img");
  img.src = "data:image/png;base64," + base64Image;
  img.alt = "Try-on result for " + title;
  body.appendChild(img);

  // Caption
  const caption = document.createElement("p");
  caption.style.cssText = "text-align:center; margin-top:12px; font-size:13px; color:#565959;";
  caption.textContent = title;
  body.appendChild(caption);

  // Save to Favorites — same as content.js ApiClient.addFavorite()
  const favDiv = document.createElement("div");
  favDiv.style.cssText = "text-align:center; margin-top:10px;";
  const favBtn = document.createElement("button");
  favBtn.className = "nova-btn-favorite";
  favBtn.innerHTML = "&#9825; Save to Favorites";
  favBtn.addEventListener("click", async () => {
    try {
      // Extract product ID from product_url (e.g. https://www.amazon.com/dp/B0123ABC)
      const asinMatch = (product.product_url || "").match(/\/dp\/([A-Z0-9]{10})/);
      const productId = asinMatch ? asinMatch[1] : product.asin || "";

      await ApiClient.addFavorite({
        productId,
        retailer: "amazon",
        productTitle: product.title || "",
        productImage: product.image_url || "",
        category: "",
        garmentClass: "",
        tryOnResultImage: base64Image,
      });
      favBtn.innerHTML = "&#9829; Saved!";
      favBtn.classList.add("nova-btn-favorite--saved");
      favBtn.disabled = true;
      showPageToast("Added to favorites!");
    } catch (err) {
      console.error("[SmartSearch] Failed to save favorite:", err);
      showPageToast("Failed to save: " + err.message);
    }
  });
  favDiv.appendChild(favBtn);
  body.appendChild(favDiv);

  // Animate button
  const animateDiv = document.createElement("div");
  animateDiv.style.cssText = "text-align:center; margin-top:8px;";
  const animateBtn = document.createElement("button");
  animateBtn.className = "nova-btn nova-btn-primary";
  animateBtn.innerHTML = "&#9654; Animate";
  animateBtn.addEventListener("click", () => handleAnimate(body, base64Image, animateBtn, product));
  animateDiv.appendChild(animateBtn);
  body.appendChild(animateDiv);
}

// ---------------------------------------------------------------------------
// Video Animation
// ---------------------------------------------------------------------------
async function handleAnimate(body, resultImageBase64, btn, product) {
  btn.disabled = true;
  btn.textContent = "Generating video... 0s";

  const videoStart = Date.now();
  const videoTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - videoStart) / 1000).toFixed(0);
    btn.textContent = `Generating video... ${elapsed}s`;
  }, 1000);

  try {
    const response = await ApiClient.generateVideo(resultImageBase64);
    const jobId = response.jobId;
    const videoProvider = response.provider || "grok";

    // Poll for video completion
    const videoResult = await pollVideoStatus(jobId, videoProvider);

    clearInterval(videoTimerInterval);
    const videoElapsed = ((Date.now() - videoStart) / 1000).toFixed(1);

    // Display the video
    const videoContainer = document.createElement("div");
    videoContainer.style.cssText = "text-align:center; margin-top:12px;";
    const videoSrc = videoResult.videoBase64
      ? `data:${videoResult.videoMimeType || "video/mp4"};base64,${videoResult.videoBase64}`
      : videoResult.videoUrl;

    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.style.cssText = "max-width:100%; border-radius:8px;";
    const source = document.createElement("source");
    source.src = videoSrc;
    source.type = "video/mp4";
    video.appendChild(source);
    videoContainer.appendChild(video);

    const actionsDiv = document.createElement("div");
    actionsDiv.style.cssText = "margin-top:8px; display:flex; justify-content:center; gap:8px; align-items:center;";

    const elapsedSpan = document.createElement("span");
    elapsedSpan.style.cssText = "font-size:12px; color:#888;";
    elapsedSpan.textContent = `Video generated in ${videoElapsed}s`;
    actionsDiv.appendChild(elapsedSpan);

    // Save button
    const saveBtn = document.createElement("button");
    saveBtn.className = "nova-btn nova-btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      saveBtn.textContent = "Saving...";
      saveBtn.disabled = true;
      try {
        const asinMatch = (product.product_url || "").match(/\/dp\/([A-Z0-9]{10})/);
        const productId = asinMatch ? asinMatch[1] : product.asin || "";
        await ApiClient.saveVideo(
          videoResult.videoUrl || null,
          videoResult.videoBase64 || null,
          productId,
          product.title || "",
          product.image_url || "",
          "amazon"
        );
        saveBtn.textContent = "Saved!";
      } catch (err) {
        console.error("[SmartSearch] Failed to save video:", err);
        saveBtn.textContent = "Failed";
        setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.disabled = false; }, 2000);
      }
    });
    actionsDiv.appendChild(saveBtn);

    // Download button
    const downloadBtn = document.createElement("button");
    downloadBtn.className = "nova-btn nova-btn-secondary";
    downloadBtn.textContent = "Download";
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
        console.error("[SmartSearch] Download failed:", err);
        downloadBtn.textContent = "Failed";
        setTimeout(() => { downloadBtn.textContent = "Download"; downloadBtn.disabled = false; }, 2000);
      }
    });
    actionsDiv.appendChild(downloadBtn);

    videoContainer.appendChild(actionsDiv);
    body.appendChild(videoContainer);

    btn.innerHTML = "&#9654; Animate";
    btn.disabled = false;
  } catch (err) {
    clearInterval(videoTimerInterval);
    console.error("[SmartSearch] Video generation failed:", err);
    btn.innerHTML = "&#9654; Animate";
    btn.disabled = false;
    const errorDiv = document.createElement("div");
    errorDiv.style.cssText = "text-align:center; margin-top:8px; color:#f44336; font-size:13px;";
    errorDiv.textContent = `Video generation failed: ${err.message}`;
    body.appendChild(errorDiv);
  }
}

let _videoPollAbort = null;

async function pollVideoStatus(jobId, provider) {
  const MAX_POLLS = 40;
  const BASE_INTERVAL = 3000;
  const MAX_INTERVAL = 15000;

  if (_videoPollAbort) _videoPollAbort.abort();
  _videoPollAbort = new AbortController();
  const signal = _videoPollAbort.signal;

  for (let i = 0; i < MAX_POLLS; i++) {
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
  }

  _videoPollAbort = null;
  throw new Error("Video generation timed out");
}

function closeTryOnModal() {
  stopTryOnTimer();
  document.getElementById("tryOnModal").hidden = true;
}
