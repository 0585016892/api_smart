const recognitionSessionService = require("../services/recognitionSession.service");

async function getList(req, res, next) {
  try {
    const result = await recognitionSessionService.getRecognitionSessions(
      req.query,
    );

    return res.json({
      success: true,
      message: "Lấy danh sách phiên nhận diện thành công",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

async function getDetail(req, res, next) {
  try {
    const result = await recognitionSessionService.getRecognitionSessionDetail(
      req.params.id,
    );

    return res.json({
      success: true,
      message: "Lấy chi tiết phiên nhận diện thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

async function close(req, res, next) {
  try {
    const result = await recognitionSessionService.closeRecognitionSession(
      req.params.id,
    );

    return res.json({
      success: true,
      message: "Đóng phiên nhận diện thành công",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getList,
  getDetail,
  close,
};
