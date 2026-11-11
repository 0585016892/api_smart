const FileType = require("file-type");

const { recognizeFace } = require("../services/faceRecognition.service");

async function recognizeFaceHandler(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng tải lên ảnh cần nhận diện",
      });
    }

    // Kiểm tra định dạng thực tế của ảnh.
    const fileType = await FileType.fromBuffer(req.file.buffer);

    const allowedTypes = ["jpg", "png", "webp"];

    if (!fileType || !allowedTypes.includes(fileType.ext)) {
      return res.status(400).json({
        success: false,
        message: "File ảnh không hợp lệ",
      });
    }

    const cameraId = req.body?.camera_id || null;

    const result = await recognizeFace(req.file.buffer, {
      cameraId,
      persist: false,
    });

    return res.json({
      success: true,
      message: result.message,
      data: result,
    });
  } catch (error) {
    if (
      error.message?.includes("Không tìm thấy khuôn mặt") ||
      error.message?.includes("nhiều hơn một khuôn mặt") ||
      error.message?.includes("quá nhỏ") ||
      error.message?.includes("vượt quá giới hạn") ||
      error.message?.includes("chưa đủ rõ")
    ) {
      return res.status(422).json({
        success: false,
        message: error.message,
      });
    }

    next(error);
  }
}

module.exports = {
  recognizeFaceHandler,
};
