const express = require("express");
const router = express.Router();
const { optionalAuth } = require("../middleware/auth");
const { spawn } = require("child_process");
const path = require("path");

router.post("/add", optionalAuth, async (req, res, next) => {
  try {
    if (process.env.ENABLE_PLAYWRIGHT !== "true") {
      return res.status(501).json({ error: "Add-to-cart is not available in this deployment" });
    }

    const { productUrl, quantity } = req.body;

    if (!productUrl) {
      return res.status(400).json({ error: "productUrl is required" });
    }

    // Validate it's a supported retailer URL with HTTPS
    const SUPPORTED_HOSTS = ['amazon.com', 'amazon.co.uk', 'shein.com', 'temu.com'];
    const urlObj = new URL(productUrl);
    if (urlObj.protocol !== 'https:') {
      return res.status(400).json({ error: "Only HTTPS URLs are accepted" });
    }
    if (!SUPPORTED_HOSTS.some(h => urlObj.hostname.includes(h))) {
      return res.status(400).json({ error: "Only supported retailer URLs are accepted" });
    }

    // For non-Amazon URLs, add-to-cart is not yet supported
    const isAmazon = urlObj.hostname.includes('amazon.com') || urlObj.hostname.includes('amazon.co.uk');
    if (!isAmazon) {
      return res.json({ success: false, message: "Add-to-cart coming soon for this retailer" });
    }

    console.log(`[cart] Adding to cart: ${productUrl}, qty: ${quantity || 1}`);

    const pythonPath = path.join(__dirname, "..", "python-services", "venv", "bin", "python3");
    const scriptPath = path.join(__dirname, "..", "python-services", "add_to_cart.py");

    const args = ["--url", productUrl];
    if (quantity && quantity > 1) {
      args.push("--quantity", String(quantity));
    }

    const CART_TIMEOUT = 60000; // 60s
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(pythonPath, [scriptPath, ...args]);

      let stdout = "";
      let stderr = "";

      // Kill the process if it exceeds the timeout
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill("SIGKILL");
          reject(new Error("Add-to-cart timed out after 60s"));
        }
      }, CART_TIMEOUT);

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (stderr) console.log(`[cart] Python stderr: ${stderr}`);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${stdout}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });

    console.log(`[cart] Result: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
