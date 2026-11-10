const express = require("express");
const router = express.Router();

const cameraController = require("../controllers/camera.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");

router.use(authenticate);

// Danh sách và chi tiết: mọi vai trò đã đăng nhập
router.get("/", cameraController.getList);
router.get("/:id", cameraController.getDetail);

// Quản lý camera
router.post("/", authorize("admin", "operator"), cameraController.create);

router.put("/:id", authorize("admin", "operator"), cameraController.update);

router.patch(
  "/:id/enabled",
  authorize("admin", "operator"),
  cameraController.toggleEnabled,
);

// Xóa camera: chỉ admin
router.delete("/:id", authorize("admin"), cameraController.remove);

module.exports = router;
