const multer = require("multer");

const errorHandler = (err, req, res, next) => {
  console.error("[API ERROR]", {
    method: req.method,
    url: req.originalUrl,
    message: err.message,
  });

  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "Ảnh không được vượt quá 5MB",
      LIMIT_FILE_COUNT: "Chỉ được tải lên một ảnh",
      LIMIT_UNEXPECTED_FILE: "Tên trường upload không hợp lệ",
    };

    return res.status(400).json({
      success: false,
      message: messages[err.code] || err.message,
    });
  }

  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    success: false,
    message:
      process.env.NODE_ENV === "production" && statusCode === 500
        ? "Đã xảy ra lỗi máy chủ"
        : err.message || "Internal Server Error",
  });
};

const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: `API không tồn tại: ${req.method} ${req.originalUrl}`,
  });
};

module.exports = {
  errorHandler,
  notFoundHandler,
};
