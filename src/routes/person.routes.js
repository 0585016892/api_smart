const express = require("express");
const router = express.Router();

const {
  getAllPersons,
  getPersonDetail,
  createPersonHandler,
  updatePerson,
  deletePerson,
  getPersonStatistics,
} = require("../controllers/person.controller");

const { authenticate, authorize } = require("../middleware/auth.middleware");

const { uploadPersonAvatar } = require("../middleware/upload.middleware");

// Tất cả API đều yêu cầu đăng nhập
router.use(authenticate);

// Thống kê
router.get("/statistics", getPersonStatistics);

// Danh sách người
router.get("/", getAllPersons);

// Thêm người
router.post(
  "/",
  authorize("admin", "operator"),
  uploadPersonAvatar,
  createPersonHandler,
);

// Chi tiết người
router.get("/:id", getPersonDetail);

// Cập nhật
router.put(
  "/:id",
  authorize("admin", "operator"),
  uploadPersonAvatar,
  updatePerson,
);

// Xóa
router.delete("/:id", authorize("admin"), deletePerson);

module.exports = router;
