const cameraService = require("../services/camera.service");

function handleError(error, next) {
  if (error.code === "ER_DUP_ENTRY") {
    error.statusCode = 409;
    error.message = "Mã camera đã tồn tại";
  }

  next(error);
}

exports.getList = async (req, res, next) => {
  try {
    const result = await cameraService.getCameraList(req.query);

    res.json({
      success: true,
      message: "Lấy danh sách camera thành công",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    handleError(error, next);
  }
};

exports.getDetail = async (req, res, next) => {
  try {
    const camera = await cameraService.getCameraById(req.params.id);

    if (!camera) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy camera",
      });
    }

    // formatCamera được dùng trong getCameraList.
    // Chi tiết cũng cần che thông tin nhạy cảm.
    let config = camera.connection_config;

    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch {
        config = null;
      }
    }

    const secretKeys = [
      "password",
      "passwd",
      "token",
      "secret",
      "api_key",
      "apikey",
      "access_key",
      "private_key",
    ];

    function redact(value) {
      if (Array.isArray(value)) return value.map(redact);

      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            secretKeys.includes(key.toLowerCase())
              ? item
                ? "********"
                : item
              : redact(item),
          ]),
        );
      }

      return value;
    }

    res.json({
      success: true,
      message: "Lấy thông tin camera thành công",
      data: {
        ...camera,
        is_enabled: Boolean(camera.is_enabled),
        connection_config: redact(config),
      },
    });
  } catch (error) {
    handleError(error, next);
  }
};

exports.create = async (req, res, next) => {
  try {
    const camera = await cameraService.createCamera(req.body);

    res.status(201).json({
      success: true,
      message: "Thêm camera thành công",
      data: camera,
    });
  } catch (error) {
    handleError(error, next);
  }
};

exports.update = async (req, res, next) => {
  try {
    const camera = await cameraService.updateCamera(req.params.id, req.body);

    res.json({
      success: true,
      message: "Cập nhật camera thành công",
      data: camera,
    });
  } catch (error) {
    handleError(error, next);
  }
};

exports.toggleEnabled = async (req, res, next) => {
  try {
    const { is_enabled } = req.body;

    if (![true, false, 0, 1, "0", "1"].includes(is_enabled)) {
      return res.status(400).json({
        success: false,
        message: "is_enabled chỉ nhận true/false hoặc 1/0",
      });
    }
    const enabled =
      is_enabled === true || is_enabled === 1 || is_enabled === "1";
    const camera = await cameraService.setCameraEnabled(req.params.id, enabled);

    res.json({
      success: true,
      message: camera.is_enabled ? "Đã bật camera" : "Đã tắt camera",
      data: camera,
    });
  } catch (error) {
    handleError(error, next);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await cameraService.deleteCamera(req.params.id);

    res.json({
      success: true,
      message: "Xóa camera thành công",
    });
  } catch (error) {
    handleError(error, next);
  }
};
