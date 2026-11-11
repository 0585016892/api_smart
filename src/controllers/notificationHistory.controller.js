// src/controllers/notificationHistory.controller.js

const notificationService = require("../services/notificationHistory.service");

async function getList(req, res, next) {
  try {
    const data = await notificationService.getNotificationHistory(req.query);

    return res.json({
      success: true,
      message: "Lấy lịch sử thông báo thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function getDetail(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "ID thông báo không hợp lệ",
      });
    }

    const data = await notificationService.getNotificationDetail(id);

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy thông báo",
      });
    }

    return res.json({
      success: true,
      message: "Lấy chi tiết thông báo thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function getStats(req, res, next) {
  try {
    const data = await notificationService.getNotificationStats(req.query);

    return res.json({
      success: true,
      message: "Lấy thống kê thông báo thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function remove(req, res, next) {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "ID thông báo không hợp lệ",
      });
    }

    const deleted = await notificationService.deleteNotificationHistory(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Thông báo không tồn tại hoặc đã được xóa",
      });
    }

    return res.json({
      success: true,
      message: "Xóa lịch sử thông báo thành công",
    });
  } catch (error) {
    next(error);
  }
}

async function cleanup(req, res, next) {
  try {
    const result = await notificationService.deleteOldNotificationHistory(
      req.body?.days,
    );

    return res.json({
      success: true,
      message: "Dọn dẹp lịch sử thông báo thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getList,
  getDetail,
  getStats,
  remove,
  cleanup,
};
