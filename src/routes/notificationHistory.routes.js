// src/routes/notificationHistory.routes.js

const express = require("express");
const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");

const notificationController = require("../controllers/notificationHistory.controller");

router.use(authenticate);

// Admin và operator được xem lịch sử.
router.use(authorize("admin", "operator"));

router.get("/", notificationController.getList);

// Phải đặt trước /:id để tránh route động bắt nhầm.
router.get("/stats", notificationController.getStats);

router.get("/:id", notificationController.getDetail);

// Chỉ admin được xóa lịch sử.
router.delete("/:id", authorize("admin"), notificationController.remove);

router.post("/cleanup", authorize("admin"), notificationController.cleanup);

module.exports = router;
