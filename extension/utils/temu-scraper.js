/**
 * Temu Product Page Scraper
 *
 * Extracts product information from Temu product pages.
 * Temu uses minified React classes that change frequently, so we rely on
 * structural selectors, data attributes, and CDN URL patterns.
 * Designed to work as a content script loaded before content.js.
 */

/**
 * Scrape product data from the current Temu product page.
 *
 * @returns {{ imageUrl: string|null, title: string|null, breadcrumbs: string, productId: string|null, price: string|null, retailer: "temu" }}
 */
function scrapeProductData() {
  // ---------------------------------------------------------------------------
  // 1. Product image — Temu uses img.kwcdn.com CDN
  // ---------------------------------------------------------------------------
  let imageUrl = null;

  // Try to find the main product gallery image (usually the largest one)
  // Temu wraps images in a carousel/gallery container
  const galleryImgs = document.querySelectorAll("img[src*='img.kwcdn.com']");
  if (galleryImgs.length) {
    // Pick the largest image (likely the main product photo)
    let maxWidth = 0;
    for (const img of galleryImgs) {
      const w = img.naturalWidth || img.width || parseInt(img.getAttribute("width") || "0", 10);
      if (w > maxWidth) {
        maxWidth = w;
        imageUrl = img.src;
      }
    }
    // If none had dimensions, just pick the first CDN image
    if (!imageUrl && galleryImgs.length) {
      imageUrl = galleryImgs[0].src;
    }
  }

  // Fallback: try data-src lazy-loaded images
  if (!imageUrl) {
    const lazyImg = document.querySelector("img[data-src*='img.kwcdn.com']");
    if (lazyImg) {
      imageUrl = lazyImg.getAttribute("data-src");
    }
  }

  // Fallback: first large image on the page
  if (!imageUrl) {
    const allImgs = document.querySelectorAll("main img, [role='main'] img, img");
    for (const img of allImgs) {
      const w = img.naturalWidth || img.width || 0;
      if (w >= 200 && img.src && !img.src.startsWith("data:") && !img.src.includes("icon") && !img.src.includes("logo")) {
        imageUrl = img.src;
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Product title — usually the only h1 on the page
  // ---------------------------------------------------------------------------
  let title = null;
  const h1 = document.querySelector("h1");
  if (h1 && h1.textContent.trim().length > 5) {
    title = h1.textContent.trim();
  }

  // Fallback: title-like element
  if (!title) {
    const titleEl = document.querySelector("[class*='title'][class*='product'], [data-testid*='title']");
    if (titleEl) title = titleEl.textContent.trim();
  }

  // ---------------------------------------------------------------------------
  // 3. Breadcrumbs (category path)
  // ---------------------------------------------------------------------------
  let breadcrumbs = "";
  const crumbSelectors = [
    "nav[class*='breadcrumb'] a",
    "[class*='breadcrumb'] a",
    "[aria-label*='breadcrumb'] a",
    "nav a[href*='/']",
  ];
  for (const sel of crumbSelectors) {
    const links = document.querySelectorAll(sel);
    if (links.length >= 2) {
      const crumbs = Array.from(links)
        .map((el) => el.textContent.trim())
        .filter((t) => t.length > 0 && t !== "Home");
      if (crumbs.length) {
        breadcrumbs = crumbs.join(" > ");
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Product ID — extract from URL or page metadata
  // ---------------------------------------------------------------------------
  let productId = null;

  // Temu URLs: temu.com/product-name-g-601100312250166.html or ?goods_id=...
  const goodsMatch = window.location.href.match(/-g-(\d+)\.html/);
  if (goodsMatch) {
    productId = goodsMatch[1];
  }

  // Fallback: goods_id query parameter
  if (!productId) {
    const urlParams = new URLSearchParams(window.location.search);
    productId = urlParams.get("goods_id") || urlParams.get("id");
  }

  // Fallback: try to extract from canonical link
  if (!productId) {
    const canonical = document.querySelector("link[rel='canonical']");
    if (canonical) {
      const canonMatch = canonical.href.match(/-g-(\d+)\.html/);
      if (canonMatch) productId = canonMatch[1];
    }
  }

  // Fallback: extract numeric ID from any part of the URL
  if (!productId) {
    const numMatch = window.location.pathname.match(/(\d{10,})/);
    if (numMatch) productId = numMatch[1];
  }

  // Fallback: try JSON-LD or page script data
  if (!productId) {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        const data = JSON.parse(script.textContent);
        if (data && data.sku) {
          productId = String(data.sku);
          break;
        }
        if (data && data.productID) {
          productId = String(data.productID);
          break;
        }
      }
    } catch (err) { console.warn("[temu-scraper] JSON-LD parse error:", err.message); }
  }

  // ---------------------------------------------------------------------------
  // 5. Price
  // ---------------------------------------------------------------------------
  let price = null;

  // Look for price elements containing $ sign
  const priceSelectors = [
    "[class*='price'] [class*='sale']",
    "[class*='price'] [class*='current']",
    "[class*='price'][class*='main']",
    "[data-testid*='price']",
  ];
  for (const sel of priceSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.includes("$")) {
      price = el.textContent.trim();
      break;
    }
  }

  // Fallback: find any element with $ and a number
  if (!price) {
    const allEls = document.querySelectorAll("[class*='price']");
    for (const el of allEls) {
      const text = el.textContent.trim();
      if (text.match(/\$\d+/) && text.length < 30) {
        price = text;
        break;
      }
    }
  }

  return { imageUrl, title, breadcrumbs, productId, price, retailer: "temu", productUrl: window.location.href };
}

/**
 * Re-scrape just the current product image URL.
 * Used when a color/variation swatch changes the displayed image.
 *
 * @returns {string|null}
 */
function scrapeCurrentImageUrl() {
  // Temu: look for the main/active gallery image
  const galleryImgs = document.querySelectorAll("img[src*='img.kwcdn.com']");
  if (galleryImgs.length) {
    let maxWidth = 0;
    let bestUrl = null;
    for (const img of galleryImgs) {
      const w = img.naturalWidth || img.width || 0;
      if (w > maxWidth) {
        maxWidth = w;
        bestUrl = img.src;
      }
    }
    if (bestUrl) return bestUrl;
    // Fallback: first CDN image
    return galleryImgs[0].src;
  }

  // Fallback: try data-src
  const lazyImg = document.querySelector("img[data-src*='img.kwcdn.com']");
  if (lazyImg) return lazyImg.getAttribute("data-src");

  return null;
}
