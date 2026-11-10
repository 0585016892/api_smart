const cameraService = require("../services/camera.service");

// =========================================================
// ERROR HANDLER
// =========================================================

function handleError(error, next) {
  if (error.code === "ER_DUP_ENTRY") {
    error.statusCode = 409;
    error.message = "Mã camera đã tồn tại";
  }

  next(error);
}

function validateId(id) {
  const value = Number(id);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw Object.assign(new Error("ID camera không hợp lệ"), {
      statusCode: 400,
    });
  }

  return value;
}

// =========================================================
// GET CAMERA LIST
// =========================================================

exports.getList = async (req, res, next) => {
  try {
    const result = await cameraService.getCameraList(req.query);

    return res.json({
      success: true,
      message: "Lấy danh sách camera thành công",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    handleError(error, next);
  }
};

// =========================================================
// GET CAMERA DETAIL
// =========================================================

exports.getDetail = async (req, res, next) => {
  try {
    const id = validateId(req.params.id);

    // Service đã format và che thông tin nhạy cảm.
    const camera = await cameraService.getCameraById(id);

    if (!camera) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy camera",
      });
    }

    return res.json({
      success: true,
      message: "Lấy thông tin camera thành công",
      data: camera,
    });
  } catch (error) {
    handleError(error, next);
  }
};

// =========================================================
// CREATE CAMERA
// =========================================================

exports.create = async (req, res, next) => {
  try {
    const result = await cameraService.createCamera(req.body);

    return res.status(201).json({
      success: true,
      message: "Thêm camera thành công",
      data: result,
    });
  } catch (error) {
    handleError(error, next);
  }
};

// =========================================================
// UPDATE CAMERA
// =========================================================

exports.update = async (req, res, next) => {
  try {
    const id = validateId(req.params.id);

    const camera = await cameraService.updateCamera(id, req.body);

    return res.json({
      success: true,
      message: "Cập nhật camera thành công",
      data: camera,
    });
  } catch (error) {
    handleError(error, next);
  }
};

// =========================================================
// ENABLE / DISABLE CAMERA
// =========================================================

exports.toggleEnabled = async (req, res, next) => {
  try {
    const id = validateId(req.params.id);
    const { is_enabled } = req.body || {};

    if (![true, false, 0, 1, "0", "1", "true", "false"].includes(is_enabled)) {
      return res.status(400).json({
        success: false,
        message: "is_enabled chỉ nhận true/false hoặc 1/0",
      });
    }

    const enabled =
      is_enabled === true ||
      is_enabled === 1 ||
      is_enabled === "1" ||
      is_enabled === "true";

    const camera = await cameraService.setCameraEnabled(id, enabled);

    return res.json({
      success: true,
      message: camera.is_enabled ? "Đã bật camera" : "Đã tắt camera",
      data: camera,
    });
  } catch (error) {
    handleError(error, next);
  }
};

// =========================================================
// DELETE CAMERA
// =========================================================

exports.remove = async (req, res, next) => {
  try {
    const id = validateId(req.params.id);

    await cameraService.deleteCamera(id);

    return res.json({
      success: true,
      message: "Xóa camera thành công",
    });
  } catch (error) {
    handleError(error, next);
  }
};
