const express = require("express");

const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");

const uploadFaces = require("../middleware/faceUpload.middleware");

const {
  getFaceProfiles,
  createFaceProfiles,
  deleteFaceProfile,
} = require("../controllers/faceProfile.controller");

// Tất cả API yêu cầu đăng nhập
router.use(authenticate);

// Xem danh sách ảnh mẫu của một người
router.get("/:personId/faces", getFaceProfiles);

// Đăng ký ảnh khuôn mặt
router.post(
  "/:personId/faces",
  authorize("admin", "operator"),
  uploadFaces,
  createFaceProfiles,
);

// Xóa một ảnh mẫu
router.delete(
  "/:personId/faces/:faceId",
  authorize("admin", "operator"),
  deleteFaceProfile,
);

module.exports = router;
