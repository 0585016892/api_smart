const fs = require("fs");

const {
  listRecognitionEvents,
  getRecognitionEventById,
  listRecognitionSessions,
  getRecognitionSessionById,
  resolveSnapshotPath,
} = require("../services/recognitionHistory.service");

async function getEvents(req, res, next) {
  try {
    const result = await listRecognitionEvents(req.query);

    return res.json({
      success: true,
      message: "Lấy lịch sử nhận diện thành công",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

async function getEventDetail(req, res, next) {
  try {
    const event = await getRecognitionEventById(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sự kiện nhận diện",
      });
    }

    return res.json({
      success: true,
      message: "Lấy chi tiết sự kiện thành công",
      data: event,
    });
  } catch (error) {
    next(error);
  }
}

async function getEventSnapshot(req, res, next) {
  try {
    const event = await getRecognitionEventById(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sự kiện nhận diện",
      });
    }

    const absolutePath = resolveSnapshotPath(event.snapshot_path);

    if (!absolutePath) {
      return res.status(404).json({
        success: false,
        message: "Sự kiện chưa có ảnh snapshot hợp lệ",
      });
    }

    try {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
    } catch {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy file snapshot",
      });
    }

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    return res.sendFile(absolutePath, (error) => {
      if (error && !res.headersSent) {
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
}

async function getSessions(req, res, next) {
  try {
    const result = await listRecognitionSessions(req.query);

    return res.json({
      success: true,
      message: "Lấy danh sách phiên vào/ra thành công",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

async function getSessionDetail(req, res, next) {
  try {
    const session = await getRecognitionSessionById(req.params.id);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy phiên nhận diện",
      });
    }

    return res.json({
      success: true,
      message: "Lấy chi tiết phiên thành công",
      data: session,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getEvents,
  getEventDetail,
  getEventSnapshot,
  getSessions,
  getSessionDetail,
};
