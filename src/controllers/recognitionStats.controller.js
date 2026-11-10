const {
  getRecognitionOverview,
  getRecognitionDailyStats,
  getRecognitionCameraStats,
} = require("../services/recognitionStats.service");

async function getOverview(req, res, next) {
  try {
    const data = await getRecognitionOverview(req.query);

    return res.json({
      success: true,
      message: "Lấy thống kê tổng quan thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function getDailyStats(req, res, next) {
  try {
    const data = await getRecognitionDailyStats(req.query);

    return res.json({
      success: true,
      message: "Lấy thống kê theo ngày thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function getCameraStats(req, res, next) {
  try {
    const data = await getRecognitionCameraStats(req.query);

    return res.json({
      success: true,
      message: "Lấy thống kê theo camera thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getOverview,
  getDailyStats,
  getCameraStats,
};
