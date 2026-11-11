const express = require("express");

const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");

const recognitionHistoryController = require("../controllers/recognitionHistory.controller");

// =====================================================
// AUTHENTICATION
// =====================================================

router.use(authenticate);

// =====================================================
// VIEW PERMISSION
// Admin, operator, viewer đều được xem lịch sử.
// =====================================================

router.use(authorize("admin", "operator", "viewer"));

// =====================================================
// RECOGNITION EVENTS
// =====================================================

// Danh sách lịch sử nhận diện
router.get("/events", recognitionHistoryController.getEvents);

// Ảnh snapshot của sự kiện
router.get(
  "/events/:id/snapshot",
  recognitionHistoryController.getEventSnapshot,
);

// Chi tiết sự kiện
router.get("/events/:id", recognitionHistoryController.getEventDetail);

// =====================================================
// RECOGNITION SESSIONS
// =====================================================

// Danh sách phiên vào/ra
router.get("/sessions", recognitionHistoryController.getSessions);

// Chi tiết phiên vào/ra
router.get("/sessions/:id", recognitionHistoryController.getSessionDetail);

// =====================================================
// ADMIN ONLY - DELETE EVENTS
// =====================================================

router.delete(
  "/events/bulk",
  authorize("admin"),
  recognitionHistoryController.deleteBulkEvents,
);

// =====================================================
// ADMIN ONLY - DELETE SESSIONS
// =====================================================

router.delete(
  "/sessions/bulk",
  authorize("admin"),
  recognitionHistoryController.deleteBulkSessions,
);

// =====================================================
// EXPORT
// =====================================================

module.exports = router;
