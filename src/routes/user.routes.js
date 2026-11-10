const express = require("express");

const {
  getList,
  getDetail,
  create,
  update,
  updateStatus,
  resetPassword,
  changeOwnPassword,
} = require("../controllers/user.controller");

const { authenticate, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.use(authenticate);

// Người dùng tự đổi mật khẩu.
router.patch("/me/password", changeOwnPassword);

// Các API quản lý tài khoản chỉ dành cho admin.
router.use(authorize("admin"));

router.get("/", getList);
router.get("/:id", getDetail);
router.post("/", create);
router.patch("/:id", update);
router.patch("/:id/status", updateStatus);
router.patch("/:id/password", resetPassword);

module.exports = router;
