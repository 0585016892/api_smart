const multer = require("multer");

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const uploadPersonAvatar = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP"));
    }

    cb(null, true);
  },
}).single("avatar");

module.exports = {
  uploadPersonAvatar,
};
