const userService = require("../services/user.service");

async function getList(req, res, next) {
  try {
    const result = await userService.getUsers(req.query);

    return res.json({
      success: true,
      message: "Lấy danh sách tài khoản thành công",
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
}

async function getDetail(req, res, next) {
  try {
    const user = await userService.getUserById(req.params.id);

    return res.json({
      success: true,
      message: "Lấy thông tin tài khoản thành công",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const user = await userService.createUser(req.body);

    return res.status(201).json({
      success: true,
      message: "Tạo tài khoản thành công",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const user = await userService.updateUser(
      req.params.id,
      req.body,
      req.user,
    );

    return res.json({
      success: true,
      message: "Cập nhật tài khoản thành công",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

async function updateStatus(req, res, next) {
  try {
    const user = await userService.updateUserStatus(
      req.params.id,
      req.body.status,
      req.user,
    );

    return res.json({
      success: true,
      message: "Cập nhật trạng thái tài khoản thành công",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

async function resetPassword(req, res, next) {
  try {
    const user = await userService.resetUserPassword(
      req.params.id,
      req.body.password,
    );

    return res.json({
      success: true,
      message: "Đặt lại mật khẩu thành công",
      data: user,
    });
  } catch (error) {
    next(error);
  }
}

async function changeOwnPassword(req, res, next) {
  try {
    await userService.changeOwnPassword(
      req.user.id,
      req.body.current_password,
      req.body.new_password,
    );

    return res.json({
      success: true,
      message: "Đổi mật khẩu thành công",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getList,
  getDetail,
  create,
  update,
  updateStatus,
  resetPassword,
  changeOwnPassword,
};
