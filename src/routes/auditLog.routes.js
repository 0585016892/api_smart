const express = require("express");

const {
  getList,
  getSummary,
  cleanup,
} = require("../controllers/auditLog.controller");

const { authenticate, authorize } = require("../middleware/auth.middleware");

const auditLog = require("../middleware/auditLog.middleware");

const router = express.Router();

router.use(authenticate);
router.use(authorize("admin"));

router.get("/", getList);
router.get("/summary", getSummary);

// Dọn nhật ký cũ; mặc định giữ lại 180 ngày.
router.post("/cleanup", auditLog, cleanup);

module.exports = router;
