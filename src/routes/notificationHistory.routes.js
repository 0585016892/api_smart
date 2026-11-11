// src/routes/recognitionHistory.routes.js

const express = require("express");
const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");
const recognitionHistoryController = require("../controllers/recognitionHistory.controller");

// Yêu cầu đăng nhập
router.use(authenticate);

// Admin và operator được xem lịch sử
router.use(authorize("admin", "operator"));

// ============================================
// XÓA NHIỀU BẢN GHI
// Đặt trước các route có /:id
// Chỉ admin được xóa
// ============================================

router.delete(
  "/events/bulk",
  authorize("admin"),
  recognitionHistoryController.deleteBulkEvents,
);

router.delete(
  "/sessions/bulk",
  authorize("admin"),
  recognitionHistoryController.deleteBulkSessions,
);

// ============================================
// LỊCH SỬ NHẬN DIỆN
// ============================================

router.get("/events", recognitionHistoryController.getEvents);

router.get(
  "/events/:id/snapshot",
  recognitionHistoryController.getEventSnapshot,
);

router.get("/events/:id", recognitionHistoryController.getEventDetail);

// ============================================
// PHIÊN VÀO / RA
// ============================================

router.get("/sessions", recognitionHistoryController.getSessions);

router.get("/sessions/:id", recognitionHistoryController.getSessionDetail);

module.exports = router;
