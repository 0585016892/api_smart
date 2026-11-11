const cameraService = require("../services/camera.service");
const cameraStreamService = require("../services/cameraStream.service");
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
// =========================================================
// LIVE CAMERA STATUS
// =========================================================

exports.getLiveStatus = async (req, res, next) => {
  try {
    const cameras = cameraStreamService.getCameraStreamStatus();

    return res.json({
      success: true,
      message: "Lấy trạng thái giám sát thành công",
      data: cameras,
    });
  } catch (error) {
    handleError(error, next);
  }
};

// =========================================================
// LIVE CAMERA FRAME - JPEG
// =========================================================

exports.getLiveFrame = async (req, res, next) => {
  try {
    const id = validateId(req.params.id);
    const result = cameraStreamService.getCameraLatestFrame(id);

    if (!result) {
      return res.status(503).json({
        success: false,
        message: "Camera chưa có frame hoặc chưa kết nối",
      });
    }

    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });

    return res.send(result.frame);
  } catch (error) {
    handleError(error, next);
  }
};

// =========================================================
// LIVE CAMERA STREAM - MJPEG
// =========================================================

exports.getLiveStream = async (req, res, next) => {
  try {
    const id = validateId(req.params.id);

    res.status(200);

    res.set({
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      Pragma: "no-cache",
      "X-Accel-Buffering": "no",
    });

    res.flushHeaders?.();

    let lastFrameAt = 0;
    let closed = false;

    const sendFrame = () => {
      if (closed || res.destroyed) return;

      const result = cameraStreamService.getCameraLatestFrame(id);

      if (!result || result.capturedAt === lastFrameAt) return;

      lastFrameAt = result.capturedAt;

      res.write(
        `--frame\r\n` +
          `Content-Type: image/jpeg\r\n` +
          `Content-Length: ${result.frame.length}\r\n\r\n`,
      );

      res.write(result.frame);
      res.write("\r\n");
    };

    const timer = setInterval(sendFrame, 100);

    sendFrame();

    req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  } catch (error) {
    if (!res.headersSent) {
      handleError(error, next);
    } else {
      res.end();
    }
  }
};
// =========================================================
// LIVE CAMERA SNAPSHOT - FRAME + TRACKS ĐỒNG BỘ
// =========================================================

exports.getLiveSnapshot = async (req, res, next) => {
  try {
    const id = validateId(req.params.id);

    const snapshot = cameraStreamService.getCameraLiveSnapshot(id);

    if (!snapshot) {
      return res.status(503).json({
        success: false,
        message: "Camera chưa có snapshot AI hoặc chưa kết nối",
      });
    }

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    return res.json({
      success: true,
      message: "Lấy LIVE snapshot thành công",

      data: {
        frame_id: snapshot.frameId,
        captured_at: snapshot.capturedAt,
        processed_at: snapshot.processedAt,

        image_width: snapshot.imageWidth,
        image_height: snapshot.imageHeight,

        person_count: snapshot.personCount,
        tracks: snapshot.tracks,

        // JPEG được mã hóa Base64 để truyền cùng tracks.
        frame: snapshot.frame.toString("base64"),
      },
    });
  } catch (error) {
    handleError(error, next);
  }
};
