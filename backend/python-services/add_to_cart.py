#!/usr/bin/env python3
"""
NovaTryOnMe — Add to Cart via Playwright
Adds a product to Amazon shopping cart using browser automation.

Usage: python add_to_cart.py --url "https://www.amazon.com/dp/B0123ABC" [--quantity 1]
"""

import argparse
import json
import sys
import time


def add_to_cart(product_url, quantity=1):
    """Add a product to Amazon cart using Playwright."""
    from playwright.sync_api import sync_playwright

    result = {"success": False, "message": ""}

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-setuid-sandbox"]
            )
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            page = context.new_page()

            # Navigate to product page
            page.goto(product_url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)

            # Handle quantity if > 1
            if quantity > 1:
                try:
                    qty_dropdown = page.locator("#quantity")
                    if qty_dropdown.count() > 0:
                        qty_dropdown.select_option(str(quantity))
                        time.sleep(0.5)
                except Exception:
                    pass  # Some products don't have quantity selector

            # Try to click "Add to Cart" button
            add_btn = page.locator("#add-to-cart-button")
            if add_btn.count() > 0:
                add_btn.click()
                time.sleep(3)

                # Check for success indicators
                # Look for "Added to Cart" confirmation or cart count change
                success_indicators = [
                    "#NATC_SMART_WAGON_CONF_MSG_SUCCESS",
                    "#attachDisplayAddBase498702",
                    "text=Added to Cart",
                    "text=Added to cart",
                    "#sw-atc-confirmation",
                    "#huc-v2-order-row-confirm-text",
                ]

                found_success = False
                for selector in success_indicators:
                    try:
                        if page.locator(selector).count() > 0:
                            found_success = True
                            break
                    except Exception:
                        continue

                if found_success:
                    result["success"] = True
                    result["message"] = "Item successfully added to cart"
                else:
                    # Check if we're on the cart page (sometimes Amazon redirects)
                    if "cart" in page.url.lower() or "gp/cart" in page.url.lower():
                        result["success"] = True
                        result["message"] = "Item added to cart (redirected to cart page)"
                    else:
                        result["success"] = True  # Optimistic — button was clicked
                        result["message"] = "Add to cart button clicked (could not confirm)"
            else:
                # Try alternative selectors
                alt_selectors = [
                    "#buy-now-button",
                    'input[name="submit.add-to-cart"]',
                    '[data-action="add-to-cart"]',
                ]
                clicked = False
                for sel in alt_selectors:
                    try:
                        btn = page.locator(sel)
                        if btn.count() > 0:
                            btn.first.click()
                            clicked = True
                            time.sleep(2)
                            result["success"] = True
                            result["message"] = "Alternative add-to-cart button clicked"
                            break
                    except Exception:
                        continue

                if not clicked:
                    result["message"] = "Could not find Add to Cart button on this page"

            browser.close()

    except Exception as e:
        result["message"] = f"Error: {str(e)}"

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Add Amazon product to cart")
    parser.add_argument("--url", required=True, help="Amazon product URL")
    parser.add_argument("--quantity", type=int, default=1, help="Quantity to add")

    args = parser.parse_args()
    result = add_to_cart(args.url, args.quantity)
    print(json.dumps(result))
