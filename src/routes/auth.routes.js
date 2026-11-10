const express = require("express");
const router = express.Router();

const rateLimit = require("express-rate-limit");

const { login, getMe } = require("../controllers/auth.controller");

const { authenticate } = require("../middleware/auth.middleware");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.",
  },
});

router.post("/login", loginLimiter, login);

router.get("/me", authenticate, getMe);

module.exports = router;
