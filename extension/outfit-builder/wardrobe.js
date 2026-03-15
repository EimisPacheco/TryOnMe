/**
 * GeminiTryOnMe — Virtual Wardrobe (Outfit Builder)
 *
 * Opens from popup Outfit Builder tab. Fires up to 3 parallel smart-searches,
 * populates wardrobe walls with hangers, enables item selection + try-on.
 *
 * NOTE: No inline event handlers — Chrome extension CSP forbids them.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let selectedTop = null;
let selectedBottom = null;
let selectedShoes = null;
let selectedItem = null; // last selected item (for try-on target)
let userPosePhoto = null;
let selectedPoseIndex = 0;
let searchStartTime = 0;
let timerInterval = null;

// Non-blocking toast notification
function showPageToast(msg, duration = 3500) {
  let toast = document.getElementById('nova-wardrobe-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'nova-wardrobe-toast';
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
let tryOnTimerInterval = null;
let lastTryOnResultBase64 = null;
let animating = false;

// ---------------------------------------------------------------------------
// Init — parse URL params, wire events, start searches
// ---------------------------------------------------------------------------
const params = new URLSearchParams(window.location.search);
const topQuery = params.get("top") || "";
const bottomQuery = params.get("bottom") || "";
const shoesQuery = params.get("shoes") || "";
const clothesSizeParam = params.get("clothesSize") || "";
const shoesSizeParam = params.get("shoesSize") || "";
const userSexParam = params.get("sex") || "";
const sexSuffix = userSexParam === "male" ? "for men" : "for women";

// Wire event listeners (NO inline handlers)
document.getElementById("tryOnBtn").addEventListener("click", handleTryOn);
document.getElementById("favoriteBtn").addEventListener("click", handleSaveFavorite);
document.getElementById("animateBtn").addEventListener("click", handleAnimateOutfit);
document.getElementById("errorCloseBtn").addEventListener("click", () => window.close());

// Clean up large base64 data on page unload
window.addEventListener("unload", () => {
  lastTryOnResultBase64 = null;
  userPosePhoto = null;
  selectedTop = null;
  selectedBottom = null;
  selectedShoes = null;
  selectedItem = null;
  if (timerInterval) clearInterval(timerInterval);
  if (tryOnTimerInterval) clearInterval(tryOnTimerInterval);
});

// Start
initWardrobe();

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
async function initWardrobe() {
  startTimer();

  const promises = [];

  if (topQuery) {
    const topSizeStr = clothesSizeParam ? ` size ${clothesSizeParam}` : "";
    promises.push(searchCategory("top", `${topQuery} ${sexSuffix}${topSizeStr}`));
  } else {
    updateCategoryStatus("top", "Skipped");
  }

  if (bottomQuery) {
    const bottomSizeStr = clothesSizeParam ? ` size ${clothesSizeParam}` : "";
    promises.push(searchCategory("bottom", `${bottomQuery} ${sexSuffix}${bottomSizeStr}`));
  } else {
    updateCategoryStatus("bottom", "Skipped");
  }

  if (shoesQuery) {
    const shoesSizeStr = shoesSizeParam ? ` size ${shoesSizeParam}` : "";
    promises.push(searchCategory("shoes", `${shoesQuery} ${sexSuffix}${shoesSizeStr}`));
  } else {
    updateCategoryStatus("shoes", "Skipped");
  }

  // Fetch user photo in parallel
  promises.push(loadUserPhoto());

  await Promise.allSettled(promises);

  stopTimer();
  showWardrobe();
}

async function searchCategory(category, query) {
  updateCategoryStatus(category, "Searching...");

  try {
    const result = await sendMessage({
      type: "SMART_SEARCH",
      query: query,
    });

    if (!result || result.error) {
      updateCategoryStatus(category, "Failed");
      console.error(`[Wardrobe] ${category} search failed:`, result?.error);
      return;
    }

    const products = result.products || [];
    updateCategoryStatus(category, products.length + " found, removing backgrounds...");
    console.log(`[Wardrobe] ${category}: ${products.length} products found`);

    // Tag each product with its category
    products.forEach((p) => {
      p._category = category;
    });

    // Remove backgrounds from product images using Gemini
    // Process in batches of 3 to avoid API rate limiting
    const maxItems = category === "shoes" ? 7 : 20;
    const items = products.slice(0, maxItems);
    const BATCH_SIZE = 3;
    let bgSuccessCount = 0;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async (product) => {
        try {
          // Fetch the product image as base64
          const imageBase64 = await sendMessage({
            type: "PROXY_IMAGE",
            url: product.image_url,
          });
          if (!imageBase64) return;

          // Resize to fit image processor requirements [320, 4096] pixels
          const resizedBase64 = await resizeImageBase64(imageBase64);

          // Remove background via Gemini image processor
          const noBgResult = await sendMessage({
            type: "REMOVE_BG",
            imageBase64: resizedBase64,
          });
          if (noBgResult && noBgResult.resultImage) {
            // Store the no-bg image as a data URL for display
            product._noBgImage = "data:image/png;base64," + noBgResult.resultImage;
            bgSuccessCount++;
          } else {
            console.warn(`[Wardrobe] BG removal returned no result for "${product.title?.substring(0, 30)}"`);
          }
        } catch (err) {
          console.warn(`[Wardrobe] BG removal failed for "${product.title?.substring(0, 30)}":`, err.message);
          // Falls back to original image_url
        }
      }));
      updateCategoryStatus(category, `${bgSuccessCount}/${items.length} backgrounds removed...`);
    }
    console.log(`[Wardrobe] ${category}: ${bgSuccessCount}/${items.length} backgrounds successfully removed`);

    updateCategoryStatus(category, products.length + " ready");
    renderCategory(category, products);
  } catch (err) {
    console.error(`[Wardrobe] ${category} search error:`, err);
    updateCategoryStatus(category, "Error");
  }
}

async function loadUserPhoto() {
  try {
    const photos = await sendMessage({ type: "GET_USER_PHOTOS" });
    if (photos && photos.bodyPhoto) {
      userPosePhoto = photos.bodyPhoto;
      selectedPoseIndex = photos.selectedPoseIndex || 0;
      showUserPhoto(userPosePhoto);
      console.log("[Wardrobe] User photo loaded, poseIndex:", selectedPoseIndex);
    }
  } catch (err) {
    console.warn("[Wardrobe] Failed to load user photo:", err);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderCategory(category, products) {
  let containerId, maxItems;
  if (category === "top") {
    containerId = "topsContainer";
    maxItems = 20;
  } else if (category === "bottom") {
    containerId = "bottomsContainer";
    maxItems = 20;
  } else {
    containerId = "shoesContainer";
    maxItems = 7;
  }

  const container = document.getElementById(containerId);
  container.innerHTML = "";

  const items = products.slice(0, maxItems);

  items.forEach((product) => {
    if (category === "shoes") {
      container.appendChild(createShoeItem(product));
    } else {
      container.appendChild(createHangerItem(product));
    }
  });
}

function createHangerItem(product) {
  const wrapper = document.createElement("div");
  wrapper.className = "hanger-item";
  wrapper.addEventListener("click", () => selectItem(product, wrapper));

  // Hanger
  const hanger = document.createElement("div");
  hanger.className = "hanger";

  const hook = document.createElement("div");
  hook.className = "hanger-hook";
  hanger.appendChild(hook);

  const body = document.createElement("div");
  body.className = "hanger-body";
  hanger.appendChild(body);

  wrapper.appendChild(hanger);

  // Clothing item card
  const card = document.createElement("div");
  card.className = "clothing-item";

  const img = document.createElement("img");
  img.src = product._noBgImage || product.image_url || "";
  img.alt = product.title || "";
  img.loading = "lazy";
  img.addEventListener("error", function () {
    // Fallback to original URL if no-bg image fails
    if (product._noBgImage && this.src === product._noBgImage) {
      this.src = product.image_url || "";
    } else {
      this.style.display = "none";
    }
  });
  card.appendChild(img);

  // Title overlay
  const title = document.createElement("div");
  title.className = "clothing-title";
  title.textContent = product.title
    ? product.title.split(" ").slice(0, 4).join(" ")
    : "Item";
  card.appendChild(title);

  // Price badge
  if (product.price) {
    const price = document.createElement("div");
    price.className = "clothing-price";
    price.textContent = product.price;
    card.appendChild(price);
  }

  wrapper.appendChild(card);
  return wrapper;
}

function createShoeItem(product) {
  const wrapper = document.createElement("div");
  wrapper.className = "shoe-display";
  wrapper.addEventListener("click", () => selectItem(product, wrapper));

  const item = document.createElement("div");
  item.className = "shoe-item";

  const img = document.createElement("img");
  img.src = product._noBgImage || product.image_url || "";
  img.alt = product.title || "";
  img.loading = "lazy";
  img.addEventListener("error", function () {
    if (product._noBgImage && this.src === product._noBgImage) {
      this.src = product.image_url || "";
    } else {
      this.style.display = "none";
    }
  });
  item.appendChild(img);

  wrapper.appendChild(item);

  const title = document.createElement("div");
  title.className = "shoe-title";
  title.textContent = product.title
    ? product.title.split(" ").slice(0, 3).join(" ")
    : "Shoes";
  wrapper.appendChild(title);

  return wrapper;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function selectItem(product, element) {
  const category = product._category;

  // Remove previous selection in SAME category only
  const containerMap = { top: "topsContainer", bottom: "bottomsContainer", shoes: "shoesContainer" };
  const container = document.getElementById(containerMap[category]);
  if (container) {
    container.querySelectorAll(".hanger-item.selected, .shoe-display.selected")
      .forEach((el) => el.classList.remove("selected"));
  }

  // Highlight new selection
  element.classList.add("selected");

  // Store per-category selection
  if (category === "top") selectedTop = product;
  else if (category === "bottom") selectedBottom = product;
  else if (category === "shoes") selectedShoes = product;

  selectedItem = product;

  // Update info bar
  document.getElementById("selectedInfo").hidden = false;
  const parts = [];
  if (selectedTop) parts.push("Top: " + (selectedTop.title || "Item").split(" ").slice(0, 3).join(" "));
  if (selectedBottom) parts.push("Bottom: " + (selectedBottom.title || "Item").split(" ").slice(0, 3).join(" "));
  if (selectedShoes) parts.push("Shoes: " + (selectedShoes.title || "Item").split(" ").slice(0, 3).join(" "));
  document.getElementById("selectedName").textContent = parts.join(" | ");
  document.getElementById("selectedPrice").textContent = product.price || "";

  // Check if Try On should be enabled:
  // Must have both top AND bottom selected, plus shoes if shoes category is present
  const needShoes = !!shoesQuery;
  const canTryOn = selectedTop && selectedBottom && (!needShoes || selectedShoes);
  document.getElementById("tryOnBtn").disabled = !canTryOn;

  // Show buy link for last selected
  if (product.product_url) {
    const buyBtn = document.getElementById("buyBtn");
    buyBtn.href = product.product_url;
    buyBtn.hidden = false;
  }

  // Activate spotlights
  document.getElementById("spotlightTop").classList.add("active");
  document.getElementById("spotlightBottom").classList.add("active");

  // Reset mirror to user photo if a previous try-on result was showing
  if (userPosePhoto) {
    showUserPhoto(userPosePhoto);
  }

  // Hide favorite and animate buttons when new selection changes
  document.getElementById("favoriteBtn").hidden = true;
  document.getElementById("animateBtn").hidden = true;
  lastTryOnResultBase64 = null;

  console.log("[Wardrobe] Selected:", product.title, "category:", category,
    "| top:", !!selectedTop, "bottom:", !!selectedBottom, "shoes:", !!selectedShoes, "canTryOn:", canTryOn);
}

// ---------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------
function showUserPhoto(base64) {
  const img = document.getElementById("mirrorPhoto");
  img.src = base64.startsWith("data:")
    ? base64
    : "data:image/jpeg;base64," + base64;
  img.hidden = false;
  document.getElementById("mirrorPlaceholder").hidden = true;
  document.getElementById("mirrorResult").hidden = true;
}

function showTryOnResult(base64) {
  const img = document.getElementById("mirrorResult");
  img.src = base64.startsWith("data:")
    ? base64
    : "data:image/png;base64," + base64;
  img.hidden = false;
  document.getElementById("mirrorPhoto").hidden = true;
  document.getElementById("mirrorPlaceholder").hidden = true;
}

// ---------------------------------------------------------------------------
// Try-On
// ---------------------------------------------------------------------------
async function handleTryOn() {
  if (!selectedTop || !selectedBottom) return;

  const btn = document.getElementById("tryOnBtn");
  btn.disabled = true;
  btn.textContent = "Processing...";

  showTryOnLoading();
  startTryOnTimer();

  try {
    // Ensure we have user photo
    if (!userPosePhoto) {
      updateTryOnStatus("Loading your photo...");
      const photos = await sendMessage({ type: "GET_USER_PHOTOS" });
      if (!photos || !photos.bodyPhoto) {
        throw new Error("Please upload your body photo first in the extension panel.");
      }
      userPosePhoto = photos.bodyPhoto;
      selectedPoseIndex = photos.selectedPoseIndex || 0;
    }

    // Build the list of garments to try on
    const garmentItems = [];
    if (selectedTop) garmentItems.push({ item: selectedTop, garmentClass: "UPPER_BODY", label: "upper wear" });
    if (selectedBottom) garmentItems.push({ item: selectedBottom, garmentClass: "LOWER_BODY", label: "lower wear" });
    if (selectedShoes) garmentItems.push({ item: selectedShoes, garmentClass: "SHOES", label: "shoes" });

    // Fetch ALL garment images in parallel
    updateTryOnStatus(`Fetching ${garmentItems.length} garment images...`);
    console.log(`[Wardrobe] Fetching ${garmentItems.length} garment images in parallel...`);

    const fetchResults = await Promise.all(
      garmentItems.map(async (g) => {
        // Prefer background-removed image (cleaner, no model) for better identity preservation
        let base64 = null;
        if (g.item._noBgImage) {
          // _noBgImage is a data URL like "data:image/png;base64,..."
          base64 = g.item._noBgImage.split(",")[1] || null;
          console.log(`[Wardrobe] Using bg-removed image for ${g.label}: ${base64?.length || 0} chars`);
        }
        if (!base64) {
          base64 = await sendMessage({ type: "PROXY_IMAGE", url: g.item.image_url });
          console.log(`[Wardrobe] Fetched original image for ${g.label}: ${base64?.length || 0} chars`);
        }
        if (!base64) throw new Error(`Failed to fetch ${g.label} image`);
        return { imageBase64: base64, garmentClass: g.garmentClass, label: g.label };
      })
    );

    // Single API call with all garments
    updateTryOnStatus(`Trying on ${fetchResults.length} garments...`);
    console.log(`[Wardrobe] Sending ${fetchResults.length} garments in a single TRY_ON_OUTFIT call`);

    const result = await sendMessage({
      type: "TRY_ON_OUTFIT",
      bodyImageBase64: null, // backend fetches from S3
      garments: fetchResults,
      framing: "full",
      poseIndex: selectedPoseIndex,
    });

    if (!result || !result.resultImage) {
      throw new Error(result?.error || "Try-on failed — no result image");
    }

    stopTryOnTimer();
    hideTryOnLoading();

    lastTryOnResultBase64 = result.resultImage;
    showTryOnResult(result.resultImage);
    console.log(`[Wardrobe] Outfit try-on complete! (${result.totalTime || "?"})`);

    // Show Save to Favorites button
    const favBtn = document.getElementById("favoriteBtn");
    favBtn.hidden = false;
    favBtn.innerHTML = "&#9825; Save to Favorites";
    favBtn.classList.remove("vw-btn-favorite--saved");

    // Show Animate button
    const animBtn = document.getElementById("animateBtn");
    animBtn.hidden = false;
    animBtn.innerHTML = "&#9654; Animate";
    animBtn.disabled = false;

  } catch (err) {
    stopTryOnTimer();
    console.error("[Wardrobe] Try-on failed:", err);
    console.error("[Wardrobe] Error details:", err.message, err.stack);
    updateTryOnStatus("Failed: " + err.message);
    // Show error for 5s then restore
    setTimeout(() => {
      hideTryOnLoading();
      if (userPosePhoto) showUserPhoto(userPosePhoto);
    }, 5000);
  } finally {
    const needShoes = !!shoesQuery;
    const canTryOn = selectedTop && selectedBottom && (!needShoes || selectedShoes);
    btn.disabled = !canTryOn;
    btn.innerHTML = "&#10024; Try On";
  }
}

// ---------------------------------------------------------------------------
// Save to Favorites
// ---------------------------------------------------------------------------
async function handleSaveFavorite() {
  if (!lastTryOnResultBase64 || (!selectedTop && !selectedBottom)) return;

  const favBtn = document.getElementById("favoriteBtn");
  favBtn.disabled = true;
  favBtn.textContent = "Saving...";

  try {
    // Strip data URI prefix if present for the result image
    let resultImage = lastTryOnResultBase64;
    if (resultImage.startsWith("data:")) {
      resultImage = resultImage.split(",")[1] || resultImage;
    }

    // Collect all outfit items
    const outfitItems = [];
    if (selectedTop) outfitItems.push({ item: selectedTop, category: "top", garmentClass: "UPPER_BODY" });
    if (selectedBottom) outfitItems.push({ item: selectedBottom, category: "bottom", garmentClass: "LOWER_BODY" });
    if (selectedShoes) outfitItems.push({ item: selectedShoes, category: "shoes", garmentClass: "SHOES" });

    // Shared outfitId links all items together
    const outfitId = "outfit_" + Date.now();

    console.log(`[Wardrobe] SAVE FAVORITE — ${outfitItems.length} items, outfitId: ${outfitId}`);

    // Save each item (all share the same try-on result image and outfitId)
    for (const { item, category, garmentClass } of outfitItems) {
      const asinMatch = (item.product_url || "").match(/\/dp\/([A-Z0-9]{10})/);
      const productId = asinMatch ? asinMatch[1] : "";
      if (!productId) continue;

      console.log(`[Wardrobe]   saving ${category}: productId=${productId}`);

      await sendMessage({
        type: "API_CALL",
        endpoint: "/api/favorites",
        method: "POST",
        data: {
          productId,
          retailer: "amazon",
          productTitle: item.title || "",
          productImage: item.image_url || "",
          category,
          garmentClass,
          tryOnResultImage: resultImage,
          outfitId,
        },
      });
    }

    console.log("[Wardrobe] All outfit items saved");
    favBtn.innerHTML = "&#9829; Saved!";
    favBtn.classList.add("vw-btn-favorite--saved");
    showPageToast("Outfit saved to favorites!");
  } catch (err) {
    console.error("[Wardrobe] Failed to save favorite:", err);
    showPageToast("Failed to save: " + err.message);
    favBtn.innerHTML = "&#9825; Save to Favorites";
  } finally {
    favBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------
function showWardrobe() {
  document.getElementById("loadingOverlay").hidden = true;
  document.getElementById("closetRoom").hidden = false;
  document.getElementById("shoeRackContainer").hidden = false;
}

function updateCategoryStatus(category, status) {
  const map = { top: "loadingTopStatus", bottom: "loadingBottomStatus", shoes: "loadingShoesStatus" };
  const el = document.getElementById(map[category]);
  if (el) el.textContent = status;
}

function showTryOnLoading() {
  document.getElementById("tryOnLoading").hidden = false;
}

function hideTryOnLoading() {
  document.getElementById("tryOnLoading").hidden = true;
}

function updateTryOnStatus(msg) {
  document.getElementById("tryOnStatus").textContent = msg;
}

function startTimer() {
  searchStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - searchStartTime) / 1000);
    document.getElementById("searchTimer").textContent = "Elapsed: " + elapsed + "s";
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function startTryOnTimer() {
  const startTime = Date.now();
  const el = document.getElementById("tryOnTimer");
  tryOnTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    el.textContent = elapsed + "s";
  }, 1000);
}

function stopTryOnTimer() {
  if (tryOnTimerInterval) {
    clearInterval(tryOnTimerInterval);
    tryOnTimerInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Image Resize — ensure images fit image processor [320, 4096] pixel range
// ---------------------------------------------------------------------------
function resizeImageBase64(base64, minDim = 320, maxDim = 4096) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;

      // Check if resize is needed
      if (width >= minDim && width <= maxDim && height >= minDim && height <= maxDim) {
        resolve(base64); // already valid
        return;
      }

      // Scale up if too small
      if (width < minDim || height < minDim) {
        const scale = Math.max(minDim / width, minDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      // Scale down if too large
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      // Return as base64 without data URI prefix
      const dataUrl = canvas.toDataURL("image/png");
      const resized = dataUrl.split(",")[1];
      console.log(`[Wardrobe] Resized image: ${img.naturalWidth}x${img.naturalHeight} → ${width}x${height}`);

      // Release canvas memory
      canvas.width = 0;
      canvas.height = 0;

      resolve(resized);
    };
    img.onerror = () => {
      console.warn("[Wardrobe] Failed to load image for resize, using original");
      resolve(base64);
    };
    // Add data URI prefix if missing
    img.src = base64.startsWith("data:") ? base64 : "data:image/jpeg;base64," + base64;
  });
}

// ---------------------------------------------------------------------------
// Video Animation
// ---------------------------------------------------------------------------
async function handleAnimateOutfit() {
  if (!lastTryOnResultBase64 || animating) return;

  animating = true;
  const btn = document.getElementById("animateBtn");
  btn.disabled = true;
  btn.textContent = "Generating video... 0s";

  const videoStart = Date.now();
  const videoTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - videoStart) / 1000).toFixed(0);
    btn.textContent = `Generating video... ${elapsed}s`;
  }, 1000);

  try {
    // Strip data URI prefix if present
    let imageBase64 = lastTryOnResultBase64;
    if (imageBase64.startsWith("data:")) {
      imageBase64 = imageBase64.split(",")[1] || imageBase64;
    }

    const response = await sendMessage({ type: "GENERATE_VIDEO", imageBase64 });
    const jobId = response.jobId;
    const videoProvider = response.provider || "grok";

    // Poll for video completion
    const videoResult = await pollVideoStatus(jobId, videoProvider);

    clearInterval(videoTimerInterval);
    const videoElapsed = ((Date.now() - videoStart) / 1000).toFixed(1);

    // Build video source
    const videoSrc = videoResult.videoBase64
      ? `data:${videoResult.videoMimeType || "video/mp4"};base64,${videoResult.videoBase64}`
      : videoResult.videoUrl;

    // Show video in an overlay on top of the mirror
    const mirrorContent = document.getElementById("mirrorContent");
    const overlay = document.createElement("div");
    overlay.id = "videoOverlay";
    overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;background:rgba(0,0,0,0.9);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;";

    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.style.cssText = "max-width:95%;max-height:70%;border-radius:8px;";
    const source = document.createElement("source");
    source.src = videoSrc;
    source.type = "video/mp4";
    video.appendChild(source);
    overlay.appendChild(video);

    const actionsDiv = document.createElement("div");
    actionsDiv.style.cssText = "margin-top:8px; display:flex; gap:8px; align-items:center;";

    const elapsedSpan = document.createElement("span");
    elapsedSpan.style.cssText = "font-size:11px; color:#aaa;";
    elapsedSpan.textContent = `Generated in ${videoElapsed}s`;
    actionsDiv.appendChild(elapsedSpan);

    // Save button
    const saveBtn = document.createElement("button");
    saveBtn.className = "vw-btn-tryon";
    saveBtn.style.cssText = "font-size:12px; padding:4px 12px;";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      saveBtn.textContent = "Saving...";
      saveBtn.disabled = true;
      try {
        const productId = selectedItem ? ((selectedItem.product_url || "").match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || "" : "";
        await sendMessage({
          type: "API_CALL",
          endpoint: "/api/video/save",
          method: "POST",
          data: {
            videoUrl: videoResult.videoUrl || null,
            videoBase64: videoResult.videoBase64 || null,
            productId,
            retailer: "amazon",
            productTitle: selectedItem?.title || "",
            productImage: selectedItem?.image_url || "",
          },
        });
        saveBtn.textContent = "Saved!";
      } catch (err) {
        console.error("[Wardrobe] Failed to save video:", err);
        saveBtn.textContent = "Failed";
        setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.disabled = false; }, 2000);
      }
    });
    actionsDiv.appendChild(saveBtn);

    // Download button
    const downloadBtn = document.createElement("button");
    downloadBtn.className = "vw-btn-tryon";
    downloadBtn.style.cssText = "font-size:12px; padding:4px 12px;";
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
        console.error("[Wardrobe] Download failed:", err);
        downloadBtn.textContent = "Failed";
        setTimeout(() => { downloadBtn.textContent = "Download"; downloadBtn.disabled = false; }, 2000);
      }
    });
    actionsDiv.appendChild(downloadBtn);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "vw-btn-tryon";
    closeBtn.style.cssText = "font-size:12px; padding:4px 12px;";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      overlay.remove();
    });
    actionsDiv.appendChild(closeBtn);

    overlay.appendChild(actionsDiv);
    mirrorContent.style.position = "relative";
    mirrorContent.appendChild(overlay);

    btn.innerHTML = "&#9654; Animate";
    btn.disabled = false;
  } catch (err) {
    clearInterval(videoTimerInterval);
    console.error("[Wardrobe] Video generation failed:", err);
    btn.innerHTML = "&#9654; Animate";
    btn.disabled = false;
    updateTryOnStatus("Video failed: " + err.message);
    setTimeout(() => hideTryOnLoading(), 3000);
  } finally {
    animating = false;
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

    const status = await sendMessage({ type: "GET_VIDEO_STATUS", jobId, provider });

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

// ---------------------------------------------------------------------------
// Messaging (same pattern as smart-search/results.js)
// ---------------------------------------------------------------------------
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (response && response.error) {
        return reject(new Error(response.error));
      }
      resolve(response?.data || response);
    });
  });
}
