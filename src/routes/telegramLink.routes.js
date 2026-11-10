const express = require("express");
const router = express.Router();

const { authenticate } = require("../middleware/auth.middleware");

const {
  createLinkCode,
  getLinkStatus,
  unlinkTelegram,
  updatePreferences,
} = require("../controllers/telegramLink.controller");

router.use(authenticate);

router.post("/link-code", createLinkCode);
router.get("/link-status", getLinkStatus);
router.delete("/unlink", unlinkTelegram);
router.patch("/preferences", updatePreferences);

module.exports = router;
