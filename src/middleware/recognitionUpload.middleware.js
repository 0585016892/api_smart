const multer = require("multer");

const uploadRecognitionImage = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1,
  },

  fileFilter: (req, file, callback) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.mimetype)) {
      return callback(new Error("Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP"));
    }

    callback(null, true);
  },
}).single("image");

module.exports = uploadRecognitionImage;
