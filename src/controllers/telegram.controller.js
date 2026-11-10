const telegramService = require("../services/telegram.service");

async function getSettings(req, res, next) {
  try {
    const data = await telegramService.getTelegramSettings();

    return res.json({
      success: true,
      message: "Lấy cấu hình Telegram thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function updateSettings(req, res, next) {
  try {
    const data = await telegramService.updateTelegramSettings(req.body);

    return res.json({
      success: true,
      message: "Cập nhật cấu hình Telegram thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function testConnection(req, res, next) {
  try {
    const data = await telegramService.testTelegramConnection();

    return res.json({
      success: true,
      message: data.message,
      data,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSettings,
  updateSettings,
  testConnection,
};
