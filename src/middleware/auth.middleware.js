const { verifyToken } = require("../utils/jwt");
const { pool } = require("../config/database");

const authenticate = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization || !authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Vui lòng đăng nhập để tiếp tục",
      });
    }

    const token = authorization.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Token không hợp lệ",
      });
    }

    const decoded = verifyToken(token);

    // Kiểm tra tài khoản còn tồn tại và đang hoạt động
    const [users] = await pool.execute(
      `SELECT
        id,
        full_name,
        username,
        email,
        role,
        status
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [decoded.id],
    );

    if (!users.length || users[0].status !== "active") {
      return res.status(401).json({
        success: false,
        message: "Tài khoản không tồn tại hoặc đã bị khóa",
      });
    }

    req.user = users[0];

    next();
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError" ||
      error.name === "NotBeforeError"
    ) {
      return res.status(401).json({
        success: false,
        message: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn",
      });
    }

    next(error);
  }
};

// Phân quyền theo vai trò
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Chưa xác thực tài khoản",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Bạn không có quyền thực hiện thao tác này",
      });
    }

    next();
  };
};

module.exports = {
  authenticate,
  authorize,
};
