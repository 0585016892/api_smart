const systemSettingService = require("../services/systemSetting.service");

async function getAll(req, res, next) {
  try {
    const result = await systemSettingService.getAllSettings();

    return res.json({
      success: true,
      message: "Lấy cấu hình hệ thống thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function getDetail(req, res, next) {
  try {
    const result = await systemSettingService.getSetting(req.params.key);

    return res.json({
      success: true,
      message: "Lấy cấu hình thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const result = await systemSettingService.updateSettings(
      req.body.settings,
      req.user.id,
    );

    return res.json({
      success: true,
      message: "Cập nhật cấu hình hệ thống thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAll,
  getDetail,
  update,
};
