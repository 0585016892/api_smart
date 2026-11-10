const express = require("express");

const {
  getList,
  getDetail,
  close,
} = require("../controllers/recognitionSession.controller");

const { authenticate, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(authenticate);

// Admin, operator và viewer đều được xem phiên nhận diện.
router.get("/", getList);
router.get("/:id", getDetail);

// Chỉ admin và operator được đóng phiên thủ công.
router.patch("/:id/close", authorize("admin", "operator"), close);

module.exports = router;
