const telegramLinkService = require("../services/telegramLink.service");

async function createLinkCode(req, res, next) {
  try {
    const data = await telegramLinkService.createLinkCode(req.user.id);

    return res.json({
      success: true,
      message: "Tạo mã liên kết Telegram thành công",
      data: {
        code: data.code,
        bot_username: process.env.TELEGRAM_BOT_USERNAME || "",
        expires_in: data.expires_in,
        start_command: `/start ${data.code}`,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function getLinkStatus(req, res, next) {
  try {
    const data = await telegramLinkService.getLinkStatus(req.user.id);

    return res.json({
      success: true,
      message: "Lấy trạng thái liên kết Telegram thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function unlinkTelegram(req, res, next) {
  try {
    const data = await telegramLinkService.unlinkTelegram(req.user.id);

    return res.json({
      success: true,
      message: "Đã hủy liên kết Telegram",
      data,
    });
  } catch (error) {
    next(error);
  }
}

async function updatePreferences(req, res, next) {
  try {
    const data = await telegramLinkService.updatePreferences(
      req.user.id,
      req.body,
    );

    return res.json({
      success: true,
      message: "Cập nhật tùy chọn Telegram thành công",
      data,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createLinkCode,
  getLinkStatus,
  unlinkTelegram,
  updatePreferences,
};
