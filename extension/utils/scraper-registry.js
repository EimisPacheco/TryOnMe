/**
 * Scraper Registry - Site Detection & Configuration
 *
 * Detects which shopping site the user is on and provides
 * site-specific selectors for button injection and overlay placement.
 * Each site's actual scraper is loaded via manifest content_scripts.
 */

const SITE_CONFIGS = {
  amazon: {
    retailer: "amazon",
    hostPattern: /amazon\.(com|co\.uk|ca|de|fr|it|es|co\.jp|com\.au|com\.br|com\.mx|in)/,
    buttonAnchor: "#imageBlock, #leftCol",
    imageContainer: "#imageBlock, #leftCol, #imgTagWrapperId",
    productUrlPattern: /\/(dp|gp\/product)\//,
  },
  shein: {
    retailer: "shein",
    hostPattern: /shein\.com/,
    buttonAnchor: ".main-picture, .crop-image-container, .atf-left, .goods-detail.product-intro, .product-intro__gallery, .goods-detail__gallery, .j-expose__product-intro",
    imageContainer: ".main-picture, .crop-image-container, .atf-left, .goods-detail.product-intro, .product-intro__gallery, .goods-detail__gallery, .j-expose__product-intro",
    productUrlPattern: /goods-p-\d+/,
  },
  temu: {
    retailer: "temu",
    hostPattern: /temu\.com/,
    buttonAnchor: "[class*='gallery'], [class*='ProductImage'], [class*='product-image'], main img:first-of-type",
    imageContainer: "[class*='gallery'], [class*='ProductImage'], [class*='product-image']",
    productUrlPattern: /[-/]\d{6,}|goods[_-]|product[_-]/i,  // Temu product page indicators
  },
};

/**
 * Detect which retailer site we're on based on hostname.
 * @returns {string|null} "amazon" | "shein" | "temu" | null
 */
function detectRetailer() {
  const hostname = window.location.hostname;
  for (const [key, config] of Object.entries(SITE_CONFIGS)) {
    if (config.hostPattern.test(hostname)) {
      return key;
    }
  }
  return null;
}

/**
 * Get the full site configuration for the current page.
 * @returns {{ retailer: string, buttonAnchor: string, imageContainer: string }}
 */
function getSiteConfig() {
  const retailer = detectRetailer();
  if (retailer && SITE_CONFIGS[retailer]) {
    return SITE_CONFIGS[retailer];
  }
  // Fallback: generic config
  return {
    retailer: "unknown",
    buttonAnchor: "main img:first-of-type",
    imageContainer: "main",
    productUrlPattern: /./,
  };
}
