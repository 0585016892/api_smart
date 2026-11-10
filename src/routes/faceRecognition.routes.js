const express = require("express");

const router = express.Router();

const { authenticate, authorize } = require("../middleware/auth.middleware");

const uploadRecognitionImage = require("../middleware/recognitionUpload.middleware");

const {
  recognizeFaceHandler,
} = require("../controllers/faceRecognition.controller");

router.use(authenticate);

// Chỉ admin và operator được thực hiện nhận diện
router.post(
  "/test",
  authorize("admin", "operator"),
  uploadRecognitionImage,
  recognizeFaceHandler,
);

module.exports = router;
