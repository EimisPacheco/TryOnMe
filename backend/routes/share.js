const express = require("express");
const router = express.Router();
const nodemailer = require("nodemailer");
const { requireAuth } = require("../middleware/auth");
const { validateBase64Image } = require("../middleware/validation");

// Gmail SMTP transporter — uses Google App Password for authentication.
// Set GMAIL_USER and GMAIL_APP_PASSWORD in your .env file.
// To generate an App Password: Google Account → Security → 2-Step Verification → App passwords
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Email sharing is not configured — GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return transporter;
}

// POST /api/share/email
router.post("/email", requireAuth, async (req, res, next) => {
  try {
    const { recipientEmail, message, resultImage, productTitle } = req.body;

    if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return res.status(400).json({ error: "Valid recipientEmail is required" });
    }

    if (!resultImage) {
      return res.status(400).json({ error: "resultImage is required" });
    }

    const imgCheck = validateBase64Image(resultImage);
    if (!imgCheck.valid) {
      return res.status(400).json({ error: `Invalid image: ${imgCheck.error}` });
    }

    const sanitize = (s) => {
      if (typeof s !== "string") return "";
      return s.replace(/<[^>]*>/g, "").replace(/&[#\w]+;/g, "").trim().slice(0, 500);
    };

    const safeMessage = sanitize(message || "");
    const safeTitle = sanitize(productTitle || "a product");

    const transport = getTransporter();

    const htmlBody = `
      <div style="font-family:system-ui,-apple-system,Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:linear-gradient(135deg,#FF9900,#FF6600);padding:20px;border-radius:12px 12px 0 0;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Gemini TryOnMe Everything</h1>
          <p style="color:rgba(255,255,255,0.9);margin:6px 0 0;font-size:14px;">Virtual Try-On Result</p>
        </div>
        <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none;">
          ${safeMessage ? `<p style="font-size:14px;color:#333;margin:0 0 16px;">${safeMessage}</p>` : ""}
          <p style="font-size:13px;color:#666;margin:0 0 12px;">Here's how <strong>${safeTitle}</strong> looks:</p>
          <div style="text-align:center;">
            <img src="cid:tryonresult" alt="Try-on result" style="max-width:100%;border-radius:8px;border:1px solid #eee;" />
          </div>
        </div>
        <div style="padding:16px;text-align:center;background:#f9f9f9;border-radius:0 0 12px 12px;border:1px solid #eee;border-top:none;">
          <p style="font-size:11px;color:#999;margin:0;">Sent via Gemini TryOnMe Everything — Try it before you buy it</p>
        </div>
      </div>
    `;

    await transport.sendMail({
      from: `"Gemini TryOnMe" <${process.env.GMAIL_USER}>`,
      to: recipientEmail,
      subject: `Virtual Try-On: ${safeTitle}`,
      html: htmlBody,
      attachments: [{
        filename: "tryon-result.jpg",
        content: Buffer.from(resultImage, "base64"),
        cid: "tryonresult",
      }],
    });

    console.log(`[share] Email sent to ${recipientEmail} by user ${req.userId}`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
