#!/usr/bin/env python3
"""
NovaTryOnMe - Smart Search with Playwright

Searches Amazon for products using browser automation, applies the mandatory
4-star+ customer review filter, and extracts up to 20 product listings.

Usage:
    python smart_search.py --query "black dresses for women"

Output:
    JSON to stdout with product data (images, titles, ratings, prices, URLs)
"""

import argparse
import json
import sys
import os
import time
from typing import Optional
from urllib.parse import quote_plus

from pydantic import BaseModel
from playwright.sync_api import sync_playwright


# ---------------------------------------------------------------------------
# Pydantic Schemas for structured extraction
# ---------------------------------------------------------------------------
class Product(BaseModel):
    title: str
    price: str
    rating: str
    review_count: str
    image_url: str
    product_url: str


class ProductList(BaseModel):
    products: list[Product]


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
AMAZON_URL = "https://www.amazon.com"
TARGET_PRODUCT_COUNT = 20
MAX_SCROLL_ROUNDS = 5


# ---------------------------------------------------------------------------
# Main search function
# ---------------------------------------------------------------------------
def smart_search(query: str, headless: bool = True) -> list[dict]:
    """
    Search Amazon for `query`, apply 4★+ filter, extract up to 20 products.
    Returns a list of product dicts.
    """
    all_products: list[Product] = []
    seen_titles: set[str] = set()

    log(f"Starting smart search for: {query}")
    log(f"Headless mode: {headless}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-web-security",
            ],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        page = context.new_page()
        page.set_default_timeout(45000)

        # Stealth: remove navigator.webdriver flag that Amazon uses to detect automation
        page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {} };
        """)

        # Step 1: Navigate directly to search results (avoids homepage bot detection)
        search_url = f"{AMAZON_URL}/s?k={quote_plus(query)}"
        log(f"Step 1: Navigating to {search_url}")
        page.goto(search_url, wait_until="domcontentloaded")

        # Wait for product results to appear (more reliable than networkidle)
        try:
            page.wait_for_selector('[data-component-type="s-search-result"], [data-asin]', timeout=15000)
            log("Step 1: Search results loaded")
        except Exception:
            log("Warning: Search result selectors not found, page might show CAPTCHA")
            # Take screenshot for debugging
            try:
                page.screenshot(path="/tmp/amazon_debug.png")
                log("Debug screenshot saved to /tmp/amazon_debug.png")
            except Exception:
                pass

        # Step 2: Apply 4-star+ customer reviews filter
        log("Step 2: Applying 4★+ customer review filter...")
        try:
            star_filter = page.locator('[aria-label*="4 Stars & Up"]').first
            if star_filter.is_visible(timeout=5000):
                star_filter.click()
                page.wait_for_load_state("networkidle")
            else:
                log("Warning: 4-star filter not visible, trying alternative...")
                alt_filter = page.locator('section[aria-label="Customer Reviews"] a').first
                if alt_filter.is_visible(timeout=3000):
                    alt_filter.click()
                    page.wait_for_load_state("networkidle")
                else:
                    log("Warning: Star filter not found, proceeding without it.")
        except Exception as e:
            log(f"Warning: Could not apply star filter: {e}")

        # Step 3: Extract products using Playwright DOM extraction
        log("Step 3: Extracting product listings via DOM...")
        for round_num in range(MAX_SCROLL_ROUNDS):
            log(f"  Extraction round {round_num + 1}/{MAX_SCROLL_ROUNDS} "
                f"(collected {len(all_products)} so far)...")

            try:
                raw_products = page.evaluate("""
                    () => {
                        let items = document.querySelectorAll('[data-component-type="s-search-result"]');
                        if (items.length === 0) items = document.querySelectorAll('[data-asin]:not([data-asin=""])');

                        const results = [];
                        items.forEach(item => {
                            try {
                                const asin = item.getAttribute('data-asin');
                                if (!asin) return;

                                // Skip sponsored items - prefer organic results
                                const isSponsored = item.querySelector('.puis-sponsored-label-text') !== null;

                                // Title: Amazon has two h2 elements:
                                //   1st h2 = brand name only (class "a-size-mini")
                                //   2nd h2 = full product title (inside a link)
                                // Use the second h2, or fall back to img alt
                                let title = '';
                                const h2List = item.querySelectorAll('h2');
                                if (h2List.length >= 2) {
                                    // Second h2 has the full title
                                    title = h2List[1].textContent.trim();
                                }
                                if (!title) {
                                    // Fallback: img alt attribute has full title
                                    const img = item.querySelector('img.s-image');
                                    if (img) {
                                        title = (img.getAttribute('alt') || '')
                                            .replace(/^Sponsored Ad - /, '');
                                    }
                                }
                                if (!title) return;

                                // Brand name from first h2
                                let brand = '';
                                if (h2List.length >= 1) {
                                    brand = h2List[0].textContent.trim();
                                }

                                // Product URL from the title link or ASIN fallback
                                let product_url = 'https://www.amazon.com/dp/' + asin;
                                const titleLink = item.querySelector('a.s-line-clamp-2, a[class*="s-link-style"][class*="a-text-normal"]');
                                if (titleLink) {
                                    const href = titleLink.getAttribute('href') || '';
                                    if (href && !href.includes('/sspa/click')) {
                                        product_url = href.startsWith('http') ? href : 'https://www.amazon.com' + href;
                                    }
                                }

                                // Price: Amazon's grid view often doesn't show price
                                // Try multiple selectors
                                let price = '';
                                const priceSpan = item.querySelector('.a-price .a-offscreen');
                                if (priceSpan) {
                                    price = priceSpan.textContent.trim();
                                }

                                // Rating: not shown in grid view, but try anyway
                                let rating = '';
                                const ratingEl = item.querySelector('[aria-label*="out of 5"]');
                                if (ratingEl) {
                                    const m = ratingEl.getAttribute('aria-label').match(/([\d.]+)/);
                                    if (m) rating = m[1];
                                }

                                // Popularity (e.g., "1K+ bought in past month")
                                let review_count = '';
                                const fullText = item.textContent;
                                const boughtMatch = fullText.match(/([\dK,]+\+?) bought in past month/);
                                if (boughtMatch) {
                                    review_count = boughtMatch[1] + ' bought';
                                }

                                // Image
                                const imgEl = item.querySelector('img.s-image');
                                const image_url = imgEl ? (imgEl.getAttribute('src') || '') : '';
                                if (!image_url) return;

                                results.push({
                                    title: brand ? brand + ' ' + title : title,
                                    price,
                                    rating,
                                    review_count,
                                    image_url,
                                    product_url,
                                    is_sponsored: isSponsored
                                });
                            } catch (e) {}
                        });
                        return results;
                    }
                """)

                if raw_products:
                    # Sort: organic results first, then sponsored
                    raw_products.sort(key=lambda x: x.get("is_sponsored", False))
                    for p in raw_products:
                        # Remove is_sponsored before creating Product
                        p.pop("is_sponsored", None)
                        if p.get("title") and p["title"] not in seen_titles:
                            seen_titles.add(p["title"])
                            all_products.append(Product(**p))

                    log(f"  Extracted {len(raw_products)} products "
                        f"({len(all_products)} unique total)")
                else:
                    log("  No products extracted in this round.")

            except Exception as e:
                log(f"  Error extracting products: {e}")

            # Check if we have enough
            if len(all_products) >= TARGET_PRODUCT_COUNT:
                log(f"Reached target of {TARGET_PRODUCT_COUNT} products.")
                break

            # Scroll down for more products
            if round_num < MAX_SCROLL_ROUNDS - 1:
                log("  Scrolling down for more products...")
                try:
                    page.evaluate("window.scrollBy(0, 1500)")
                    time.sleep(1.5)
                except Exception as e:
                    log(f"  Error scrolling: {e}")
                    break

        browser.close()

    # Trim to target count
    final_products = all_products[:TARGET_PRODUCT_COUNT]
    log(f"Search complete. Returning {len(final_products)} products.")

    return [p.model_dump() for p in final_products]


def log(message: str):
    """Log to stderr so stdout stays clean for JSON output."""
    print(f"[smart_search] {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Smart Search: Amazon product search with Playwright"
    )
    parser.add_argument(
        "--query", "-q",
        required=True,
        help="Natural language search query (e.g. 'black dresses for women')"
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=True,
        help="Run browser in headless mode (default: True)"
    )
    parser.add_argument(
        "--no-headless",
        action="store_true",
        default=False,
        help="Run browser with visible UI (for debugging)"
    )

    args = parser.parse_args()
    headless = not args.no_headless

    try:
        products = smart_search(args.query, headless=headless)
        # Output JSON to stdout (Node.js reads this)
        print(json.dumps({"success": True, "products": products}))
    except Exception as e:
        log(f"Fatal error: {e}")
        print(json.dumps({"success": False, "error": str(e), "products": []}))
        sys.exit(1)


if __name__ == "__main__":
    main()
