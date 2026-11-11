const fs = require("fs");

const recognitionHistoryService = require("../services/recognitionHistory.service");

// =====================================================
// COMMON RESPONSE
// =====================================================

function sendSuccess(res, message, data = null, extra = {}) {
  return res.json({
    success: true,
    message,
    ...(data !== null ? { data } : {}),
    ...extra,
  });
}

// =====================================================
// GET RECOGNITION EVENTS
// =====================================================

/**
 * GET /api/recognition-history/events
 *
 * Query:
 * - page
 * - limit
 * - status: known | unknown | uncertain
 * - direction: entry | exit | unknown
 * - person_id
 * - camera_id
 * - from: YYYY-MM-DD
 * - to: YYYY-MM-DD
 * - keyword
 */
async function getEvents(req, res, next) {
  try {
    const result = await recognitionHistoryService.listRecognitionEvents(
      req.query,
    );

    return sendSuccess(res, "Lấy lịch sử nhận diện thành công", result.items, {
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

// =====================================================
// GET EVENT DETAIL
// =====================================================

/**
 * GET /api/recognition-history/events/:id
 */
async function getEventDetail(req, res, next) {
  try {
    const event = await recognitionHistoryService.getRecognitionEventById(
      req.params.id,
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sự kiện nhận diện",
      });
    }

    return sendSuccess(res, "Lấy chi tiết sự kiện thành công", event);
  } catch (error) {
    next(error);
  }
}

// =====================================================
// GET EVENT SNAPSHOT
// =====================================================

/**
 * GET /api/recognition-history/events/:id/snapshot
 *
 * Trả về ảnh snapshot của sự kiện.
 */
async function getEventSnapshot(req, res, next) {
  try {
    const event = await recognitionHistoryService.getRecognitionEventById(
      req.params.id,
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sự kiện nhận diện",
      });
    }

    const absolutePath = recognitionHistoryService.resolveSnapshotPath(
      event.snapshot_path,
    );

    if (!absolutePath) {
      return res.status(404).json({
        success: false,
        message: "Sự kiện chưa có ảnh snapshot hợp lệ",
      });
    }

    try {
      await fs.promises.access(absolutePath, fs.constants.R_OK);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES") {
        return res.status(404).json({
          success: false,
          message: "Không tìm thấy file snapshot",
        });
      }

      throw error;
    }

    res.setHeader("Cache-Control", "private, no-store");

    res.setHeader("X-Content-Type-Options", "nosniff");

    res.setHeader("Content-Type", "image/jpeg");

    return res.sendFile(
      absolutePath,
      {
        dotfiles: "deny",
        cacheControl: false,
      },
      (error) => {
        if (error && !res.headersSent) {
          next(error);
        }
      },
    );
  } catch (error) {
    next(error);
  }
}

// =====================================================
// GET RECOGNITION SESSIONS
// =====================================================

/**
 * GET /api/recognition-history/sessions
 *
 * Query:
 * - page
 * - limit
 * - status: known | unknown | uncertain
 * - session_status: open | closed
 * - person_id
 * - camera_id
 * - from: YYYY-MM-DD
 * - to: YYYY-MM-DD
 * - keyword
 */
async function getSessions(req, res, next) {
  try {
    const result = await recognitionHistoryService.listRecognitionSessions(
      req.query,
    );

    return sendSuccess(
      res,
      "Lấy danh sách phiên vào/ra thành công",
      result.items,
      {
        pagination: result.pagination,
      },
    );
  } catch (error) {
    next(error);
  }
}

// =====================================================
// GET SESSION DETAIL
// =====================================================

/**
 * GET /api/recognition-history/sessions/:id
 */
async function getSessionDetail(req, res, next) {
  try {
    const session = await recognitionHistoryService.getRecognitionSessionById(
      req.params.id,
    );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy phiên nhận diện",
      });
    }

    return sendSuccess(res, "Lấy chi tiết phiên thành công", session);
  } catch (error) {
    next(error);
  }
}

// =====================================================
// BULK DELETE EVENTS
// =====================================================

/**
 * DELETE /api/recognition-history/events/bulk
 *
 * Body:
 * {
 *   "ids": [1, 2, 3]
 * }
 */
async function deleteBulkEvents(req, res, next) {
  try {
    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn ít nhất một sự kiện cần xóa",
      });
    }

    const result =
      await recognitionHistoryService.bulkDeleteRecognitionEvents(ids);

    return sendSuccess(res, "Xóa lịch sử nhận diện thành công", result);
  } catch (error) {
    next(error);
  }
}

// =====================================================
// BULK DELETE SESSIONS
// =====================================================

/**
 * DELETE /api/recognition-history/sessions/bulk
 *
 * Body:
 * {
 *   "ids": [1, 2, 3]
 * }
 */
async function deleteBulkSessions(req, res, next) {
  try {
    const { ids } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn ít nhất một phiên cần xóa",
      });
    }

    const result =
      await recognitionHistoryService.bulkDeleteRecognitionSessions(ids);

    return sendSuccess(res, "Xóa phiên ra vào thành công", result);
  } catch (error) {
    next(error);
  }
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  getEvents,
  getEventDetail,
  getEventSnapshot,

  getSessions,
  getSessionDetail,

  deleteBulkEvents,
  deleteBulkSessions,
};
