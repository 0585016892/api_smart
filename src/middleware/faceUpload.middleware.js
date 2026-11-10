const multer = require("multer");

const storage = multer.memoryStorage();

const uploadFaces = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 10,
  },

  fileFilter: (req, file, callback) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];

    if (!allowedTypes.includes(file.mimetype)) {
      return callback(new Error("Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP"));
    }

    callback(null, true);
  },
}).array("faces", 10);

module.exports = uploadFaces;
