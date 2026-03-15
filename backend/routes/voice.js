const express = require("express");
const router = express.Router();
const { optionalAuth } = require("../middleware/auth");
const giselle = require("../services/giselle");

router.post("/", optionalAuth, async (req, res, next) => {
  try {
    const { message, history, userContext } = req.body;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "message is required" });
    }

    console.log(`[voice] Chat message: "${message.slice(0, 80)}"`);

    const result = await giselle.chat(
      message.trim(),
      Array.isArray(history) ? history : [],
      userContext || {}
    );

    res.json(result);
  } catch (error) {
    console.error("[voice] Error:", error.message);
    next(error);
  }
});

module.exports = router;
