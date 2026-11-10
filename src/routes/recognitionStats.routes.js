const express = require("express");

const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");

const {
  getOverview,
  getDailyStats,
  getCameraStats,
} = require("../controllers/recognitionStats.controller");

router.use(authenticate);
router.use(authorize("admin", "operator", "viewer"));

router.get("/overview", getOverview);
router.get("/daily", getDailyStats);
router.get("/cameras", getCameraStats);

module.exports = router;
