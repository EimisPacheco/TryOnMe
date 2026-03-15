/**
 * SHEIN Product Page Scraper
 *
 * Extracts product information from SHEIN product pages.
 * Works on us.shein.com, www.shein.com, and regional SHEIN domains.
 * Designed to work as a content script loaded before content.js.
 */

/**
 * Scrape product data from the current SHEIN product page.
 *
 * @returns {{ imageUrl: string|null, title: string|null, breadcrumbs: string, productId: string|null, price: string|null, retailer: "shein" }}
 */
function scrapeProductData() {
  // ---------------------------------------------------------------------------
  // 1. Product image — try multiple selectors for the main gallery image
  // ---------------------------------------------------------------------------
  let imageUrl = null;

  // Primary: the active/main gallery image
  const selectors = [
    ".product-intro__head-image img",
    ".goods-detail__gallery .swiper-slide-active img",
    ".crop-image-container img",
    ".goods-detail__gallery img",
    ".j-expose__product-intro img",
    ".S-product-card__img img",
  ];

  for (const sel of selectors) {
    const img = document.querySelector(sel);
    if (img) {
      // SHEIN uses data-src for lazy loading
      imageUrl = img.getAttribute("data-src") || img.getAttribute("src") || null;
      if (imageUrl && !imageUrl.startsWith("data:")) break;
      imageUrl = null;
    }
  }

  // Fallback: find the largest product image on the page
  if (!imageUrl) {
    const allImgs = document.querySelectorAll("img[src*='img.ltwebstatic.com']");
    let maxWidth = 0;
    for (const img of allImgs) {
      const w = img.naturalWidth || img.width || 0;
      if (w > maxWidth) {
        maxWidth = w;
        imageUrl = img.src;
      }
    }
  }

  // Also try data-src variants
  if (!imageUrl) {
    const lazySrc = document.querySelector("img[data-src*='img.ltwebstatic.com']");
    if (lazySrc) {
      imageUrl = lazySrc.getAttribute("data-src");
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Product title
  // ---------------------------------------------------------------------------
  let title = null;
  const titleSelectors = [
    ".product-intro__head-name",
    ".goods-title h1",
    "h1[class*='title']",
    "h1",
  ];
  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 5) {
      title = el.textContent.trim();
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Breadcrumbs (category path)
  // ---------------------------------------------------------------------------
  let breadcrumbs = "";
  const crumbSelectors = [
    ".bread-crumb__inner a",
    ".breadcrumb a",
    "nav[aria-label*='breadcrumb'] a",
    "[class*='breadcrumb'] a",
  ];
  for (const sel of crumbSelectors) {
    const links = document.querySelectorAll(sel);
    if (links.length > 0) {
      const crumbs = Array.from(links)
        .map((el) => el.textContent.trim())
        .filter(Boolean);
      breadcrumbs = crumbs.join(" > ");
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Product ID — extract from URL pattern /goods-p-{ID}.html
  // ---------------------------------------------------------------------------
  let productId = null;

  // URL pattern: /goods-p-337181652.html
  const goodsMatch = window.location.href.match(/goods-p-(\d+)/);
  if (goodsMatch) {
    productId = goodsMatch[1];
  }

  // Fallback: goods_id query parameter
  if (!productId) {
    const urlParams = new URLSearchParams(window.location.search);
    productId = urlParams.get("goods_id") || urlParams.get("id");
  }

  // Fallback: SKU from page
  if (!productId) {
    const skuEl = document.querySelector("[class*='sku'], [class*='SKU']");
    if (skuEl) {
      const skuMatch = skuEl.textContent.match(/\b(\d{6,})\b/);
      if (skuMatch) productId = skuMatch[1];
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Price
  // ---------------------------------------------------------------------------
  let price = null;
  const priceSelectors = [
    ".product-intro__head-mainprice",
    ".from-wrapper .from",
    "[class*='price'] [class*='sale']",
    "[class*='price'] [class*='current']",
    ".original.special",
  ];
  for (const sel of priceSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.includes("$")) {
      price = el.textContent.trim();
      break;
    }
  }

  return { imageUrl, title, breadcrumbs, productId, price, retailer: "shein", productUrl: window.location.href };
}

/**
 * Re-scrape just the current product image URL.
 * Used when a color/variation swatch changes the displayed image.
 *
 * @returns {string|null}
 */
function scrapeCurrentImageUrl() {
  const selectors = [
    ".product-intro__head-image img",
    ".goods-detail__gallery .swiper-slide-active img",
    ".crop-image-container img",
    ".goods-detail__gallery img",
  ];

  for (const sel of selectors) {
    const img = document.querySelector(sel);
    if (img) {
      const url = img.getAttribute("data-src") || img.getAttribute("src");
      if (url && !url.startsWith("data:")) return url;
    }
  }

  // Fallback: largest SHEIN CDN image
  const allImgs = document.querySelectorAll("img[src*='img.ltwebstatic.com']");
  let maxWidth = 0;
  let bestUrl = null;
  for (const img of allImgs) {
    const w = img.naturalWidth || img.width || 0;
    if (w > maxWidth) {
      maxWidth = w;
      bestUrl = img.src;
    }
  }
  return bestUrl;
}
