const auditLogService = require("../services/auditLog.service");

async function getList(req, res, next) {
  try {
    const result = await auditLogService.getAuditLogs(req.query);

    return res.json({
      success: true,
      message: "Lấy nhật ký hoạt động thành công",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

async function getSummary(req, res, next) {
  try {
    const result = await auditLogService.getAuditSummary();

    return res.json({
      success: true,
      message: "Lấy thống kê nhật ký thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function cleanup(req, res, next) {
  try {
    const result = await auditLogService.deleteOldAuditLogs(
      req.body.retention_days || 180,
    );

    return res.json({
      success: true,
      message: "Dọn dẹp nhật ký hoạt động thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getList,
  getSummary,
  cleanup,
};
