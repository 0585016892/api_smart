const express = require("express");
const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");

const {
  getSettings,
  updateSettings,
  testConnection,
} = require("../controllers/telegram.controller");

router.use(authenticate);
router.use(authorize("admin"));

router.get("/settings", getSettings);
router.put("/settings", updateSettings);
router.post("/test", testConnection);

module.exports = router;
