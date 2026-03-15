/**
 * GeminiTryOnMe - Google Shopping Content Script
 *
 * Unlike product detail pages (Amazon, Shein, Temu), Google Shopping shows a
 * grid of products. This script adds a "Try It On" button on each
 * product image and opens the try-on result in a lightbox overlay.
 *
 * Dependencies (loaded before this file via manifest content_scripts):
 *   - utils/google-shopping-scraper.js  -> helper functions
 *   - utils/image-utils.js              -> fetchImageAsBase64(), base64ToDataUrl()
 *   - utils/api-client.js               -> ApiClient
 */
(function () {
  "use strict";

  // Only activate on Google Shopping tabs (udm=28) or shopping.google.com
  const isShoppingPage =
    window.location.hostname === "shopping.google.com" ||
    new URLSearchParams(window.location.search).get("udm") === "28";
  if (!isShoppingPage) return;

  if (window.__geminiTryOnMeGShopLoaded) return;
  window.__geminiTryOnMeGShopLoaded = true;

  console.log("[GeminiTryOnMe] Google Shopping content script loaded");

  let currentFraming = "full";
  try {
    chrome.storage.local.get(["tryOnFraming"], (r) => {
      if (r.tryOnFraming) currentFraming = r.tryOnFraming;
    });
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // Find product images and their containers
  // ---------------------------------------------------------------------------
  function isProductImage(img) {
    const src = img.src || img.getAttribute("data-src") || "";
    if (src.includes("gstatic.com/images/branding") || src.includes("google.com/favicon")) return false;
    if (src.includes("googleusercontent.com/kp") || src.startsWith("data:")) return false;
    const r = img.getBoundingClientRect();
    return r.width >= 60 && r.height >= 60 && r.top > -500;
  }

  function findProductImages() {
    return Array.from(document.querySelectorAll("img")).filter(isProductImage);
  }

  function findCardAncestor(img) {
    let el = img.parentElement;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      if (el.querySelector("a[href]") && el.textContent.trim().length > 5) return el;
      el = el.parentElement;
    }
    return null;
  }

  function getCardImage(card) {
    const img =
      card.querySelector("img.VeBrne") ||
      card.querySelector("img.nGT6qb") ||
      card.querySelector("img");
    if (!img) return null;
    return img.getAttribute("data-src") || img.src || null;
  }

  function getCardTitle(card) {
    const heading =
      card.querySelector("h3") || card.querySelector("h4") || card.querySelector("[role='heading']");
    if (heading) return heading.textContent.trim();
    const img = card.querySelector("img[alt]");
    return img ? img.alt.trim() : "";
  }

  function getCardPrice(card) {
    const spans = Array.from(card.querySelectorAll("span"));
    const priceSpan = spans.find(
      (s) => /^\$[\d,.]+$/.test(s.textContent.trim()) && s.children.length === 0
    );
    return priceSpan ? priceSpan.textContent.trim() : null;
  }

  function getCardLink(card) {
    const a = card.tagName === "A" ? card : card.querySelector("a[href]");
    if (!a) return null;
    const href = a.href;
    try {
      const u = new URL(href);
      const realUrl = u.searchParams.get("url") || u.searchParams.get("q");
      if (realUrl && realUrl.startsWith("http")) return realUrl;
    } catch (_) {}
    return href;
  }

  function getCardProductId(card) {
    return (
      card.getAttribute("data-cid") ||
      card.getAttribute("data-docid") ||
      card.getAttribute("data-oid") ||
      "gshop_" + hashCode(getCardLink(card) || getCardTitle(card) || Math.random().toString())
    );
  }

  // ---------------------------------------------------------------------------
  // Inject "Try It On" buttons on each product image
  // ---------------------------------------------------------------------------
  function injectTryOnButtons() {
    const imgs = findProductImages();
    console.log(`[GeminiTryOnMe] Found ${imgs.length} product images`);

    imgs.forEach((img) => {
      const wrapper = img.parentElement;
      if (!wrapper || wrapper.querySelector(".nova-gshopping-tryon-btn")) return;

      const computed = window.getComputedStyle(wrapper);
      if (computed.position === "static") {
        wrapper.style.position = "relative";
      }

      const btn = document.createElement("button");
      btn.className = "nova-gshopping-tryon-btn";
      btn.textContent = "Try It On";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleTryOn(img);
      });

      wrapper.appendChild(btn);
    });
  }

  // ---------------------------------------------------------------------------
  // Try-on flow for a specific product card
  // ---------------------------------------------------------------------------
  async function handleTryOn(img) {
    const imgUrl = img.getAttribute("data-src") || img.src;
    const card = findCardAncestor(img);
    const title = card ? getCardTitle(card) : (img.alt || "");
    const productUrl = card ? getCardLink(card) : null;
    const productId = card ? getCardProductId(card) : "gshop_" + hashCode(imgUrl);
    const price = card ? getCardPrice(card) : null;

    if (!imgUrl) return;

    const btn = img.parentElement.querySelector(".nova-gshopping-tryon-btn");
    if (!btn) return;
    const originalText = btn.textContent;
    btn.textContent = "Loading...";
    btn.disabled = true;

    try {
      // 1. Fetch product image
      const imageBase64 = await fetchImageAsBase64(imgUrl);

      // 2. Analyze the product
      let analysis = null;
      try {
        analysis = await ApiClient.analyzeProduct(imageBase64, title, "");
      } catch (err) {
        console.error("[GeminiTryOnMe] GShop analysis failed:", err);
      }

      if (analysis && analysis.supported === false) {
        btn.textContent = "Not supported";
        setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 2000);
        return;
      }

      const isCosmetic = analysis && analysis.category === "cosmetics";

      // 3. Get pose/face index
      const poseIdx = await new Promise((r) =>
        chrome.storage.local.get(["selectedPoseIndex"], (s) => r(s.selectedPoseIndex || 0))
      );
      const faceIdx = await new Promise((r) =>
        chrome.storage.local.get(["selectedFaceIndex"], (s) => r(s.selectedFaceIndex || 0))
      );

      btn.textContent = "Generating...";

      // 4. Call try-on
      let resultImage;
      if (isCosmetic) {
        const resp = await ApiClient.tryOnCosmetics(
          null,
          analysis.cosmeticType || "lipstick",
          analysis.color || null,
          faceIdx,
          imageBase64
        );
        resultImage = resp.resultImage;
      } else {
        const resp = await ApiClient.tryOn(
          null,
          imageBase64,
          analysis ? analysis.garmentClass : null,
          "SEAMLESS",
          currentFraming,
          poseIdx,
          title
        );
        resultImage = resp.resultImage;
      }

      if (!resultImage) throw new Error("No result image");

      // 5. Show result in a lightbox
      showResultLightbox(resultImage, {
        title,
        price,
        productUrl,
        productId,
        imageUrl: imgUrl,
        retailer: "google_shopping",
        category: analysis ? analysis.category : "",
        garmentClass: analysis ? analysis.garmentClass : "",
        styleTips: analysis ? analysis.styleTips : null,
      });
    } catch (err) {
      console.error("[GeminiTryOnMe] GShop try-on failed:", err);
      btn.textContent = "Failed - Retry";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 3000);
      return;
    }

    btn.textContent = originalText;
    btn.disabled = false;
  }

  // ---------------------------------------------------------------------------
  // Result lightbox
  // ---------------------------------------------------------------------------
  function showResultLightbox(resultImage, product) {
    const existing = document.querySelector(".nova-gshopping-lightbox");
    if (existing) existing.remove();

    const dataUrl = base64ToDataUrl(resultImage);

    const lightbox = document.createElement("div");
    lightbox.className = "nova-gshopping-lightbox";
    lightbox.innerHTML = `
      <div class="nova-gshopping-lightbox-inner">
        <button class="nova-gshopping-lightbox-close">&times;</button>
        <img src="${dataUrl}" alt="Try-on result" class="nova-gshopping-lightbox-img" />
        <div class="nova-gshopping-lightbox-info">
          <h3>${product.title || "Product"}</h3>
          ${product.price ? `<p class="nova-gshopping-lightbox-price">${product.price}</p>` : ""}
          ${product.styleTips ? `<p class="nova-gshopping-lightbox-tips">${Array.isArray(product.styleTips) ? product.styleTips.join(" ") : product.styleTips}</p>` : ""}
          <div class="nova-gshopping-lightbox-actions">
            ${product.productUrl ? `<a href="${product.productUrl}" target="_blank" class="nova-gshopping-btn-link">View Product</a>` : ""}
            <button class="nova-gshopping-btn-fav">Save to Favorites</button>
            <button class="nova-gshopping-btn-download">Download</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(lightbox);

    // Close
    lightbox.querySelector(".nova-gshopping-lightbox-close").addEventListener("click", () => lightbox.remove());
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) lightbox.remove();
    });

    // Explicit click handler for View Product — open via background script to bypass CSP
    const viewProductLink = lightbox.querySelector(".nova-gshopping-btn-link");
    if (viewProductLink) {
      viewProductLink.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const url = viewProductLink.getAttribute("href") || viewProductLink.href;
        console.log("[GeminiTryOnMe] Opening product URL:", url);
        chrome.runtime.sendMessage({ type: "OPEN_URL", url });
      });
    }

    // Save to favorites
    lightbox.querySelector(".nova-gshopping-btn-fav").addEventListener("click", async (e) => {
      const favBtn = e.target;
      try {
        favBtn.textContent = "Saving...";
        await ApiClient.addFavorite({
          asin: product.productId,
          productTitle: product.title || "",
          productImage: product.imageUrl || "",
          productUrl: product.productUrl || "",
          retailer: product.retailer,
          category: product.category,
          garmentClass: product.garmentClass,
          tryOnResultImage: resultImage,
        });
        favBtn.textContent = "Saved!";
        favBtn.disabled = true;
      } catch (err) {
        console.error("[GeminiTryOnMe] Save favorite failed:", err);
        favBtn.textContent = "Failed";
      }
    });

    // Download
    lightbox.querySelector(".nova-gshopping-btn-download").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `tryon-${product.productId || "result"}.jpg`;
      a.click();
    });
  }

  // ---------------------------------------------------------------------------
  // Observe DOM changes to inject buttons on dynamically loaded cards
  // ---------------------------------------------------------------------------
  function setupObserver() {
    let debounceTimer = null;
    const debouncedInject = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => injectTryOnButtons(), 300);
    };

    // Watch for new nodes AND attribute changes (lazy-loaded image src updates)
    const observer = new MutationObserver(debouncedInject);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-src"],
    });

    // Also re-inject on scroll (catches images that enter the viewport)
    let scrollTimer = null;
    window.addEventListener("scroll", () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => injectTryOnButtons(), 500);
    }, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    setTimeout(() => {
      injectTryOnButtons();
      setupObserver();
    }, 1500);

    // Re-inject after more images have loaded
    setTimeout(() => injectTryOnButtons(), 3000);
    setTimeout(() => injectTryOnButtons(), 6000);
  }

  init();
})();
