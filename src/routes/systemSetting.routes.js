const express = require("express");

const {
  getAll,
  getDetail,
  update,
} = require("../controllers/systemSetting.controller");

const { authenticate, authorize } = require("../middleware/auth.middleware");

const auditLog = require("../middleware/auditLog.middleware");

const router = express.Router();

router.use(authenticate);
router.use(authorize("admin"));

router.get("/", getAll);
router.get("/:key", getDetail);

router.patch("/", auditLog, update);

module.exports = router;
