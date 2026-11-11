const express = require("express");

const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");

const {
  getEvents,
  getEventDetail,
  getEventSnapshot,
  getSessions,
  getSessionDetail,
} = require("../controllers/recognitionHistory.controller");

router.use(authenticate);

// Admin, operator và viewer đều được xem lịch sử.
router.use(authorize("admin", "operator", "viewer"));

router.get("/events", getEvents);
router.get("/events/:id/snapshot", getEventSnapshot);
router.get("/events/:id", getEventDetail);

router.get("/sessions", getSessions);
router.get("/sessions/:id", getSessionDetail);

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

module.exports = router;
