const express = require("express");
const router = express.Router();
const { signUp, confirmSignUp, signIn, refreshTokens, resendCode } = require("../services/firebaseAuth");

router.post("/signup", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    console.log(`[auth] Signup request for: ${email}`);
    if (!email || !password) {
      console.log("[auth] Signup rejected: missing email or password");
      return res.status(400).json({ error: "email and password are required" });
    }
    const result = await signUp(email, password);
    console.log(`[auth] Signup success for: ${email}, uid: ${result.userSub}`);
    res.json(result);
  } catch (error) {
    console.error(`[auth] Signup failed for: ${req.body.email}`, error.code, error.message);
    if (error.code === "auth/email-already-exists") {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    if (error.code === "auth/invalid-password") {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

router.post("/confirm", async (req, res, next) => {
  try {
    const { email, code } = req.body;
    console.log(`[auth] Confirm request for: ${email}, code: ${code}`);
    if (!email || !code) {
      console.log("[auth] Confirm rejected: missing email or code");
      return res.status(400).json({ error: "email and code are required" });
    }
    const result = await confirmSignUp(email, code);
    console.log(`[auth] Confirm success for: ${email}`);
    res.json(result);
  } catch (error) {
    console.error(`[auth] Confirm failed for: ${req.body.email}`, error.message);
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    console.log(`[auth] Login request for: ${email}`);
    if (!email || !password) {
      console.log("[auth] Login rejected: missing email or password");
      return res.status(400).json({ error: "email and password are required" });
    }
    const tokens = await signIn(email, password);
    console.log(`[auth] Login success for: ${email}`);
    res.json(tokens);
  } catch (error) {
    console.error(`[auth] Login failed for: ${req.body.email}`, error.code, error.message);
    if (error.code === "INVALID_PASSWORD" || error.code === "INVALID_LOGIN_CREDENTIALS") {
      return res.status(401).json({ error: "Incorrect email or password" });
    }
    if (error.code === "EMAIL_NOT_FOUND") {
      return res.status(401).json({ error: "Incorrect email or password" });
    }
    next(error);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    console.log("[auth] Token refresh request");
    if (!refreshToken) {
      console.log("[auth] Refresh rejected: missing refreshToken");
      return res.status(400).json({ error: "refreshToken is required" });
    }
    const tokens = await refreshTokens(refreshToken);
    console.log("[auth] Token refresh success");
    res.json(tokens);
  } catch (error) {
    console.error("[auth] Token refresh failed:", error.message);
    next(error);
  }
});

router.post("/resend-code", async (req, res, next) => {
  try {
    const { email } = req.body;
    console.log(`[auth] Resend code request for: ${email}`);
    if (!email) {
      console.log("[auth] Resend rejected: missing email");
      return res.status(400).json({ error: "email is required" });
    }
    const result = await resendCode(email);
    console.log(`[auth] Resend code success for: ${email}`);
    res.json(result);
  } catch (error) {
    console.error(`[auth] Resend code failed for: ${req.body.email}`, error.message);
    next(error);
  }
});

module.exports = router;
