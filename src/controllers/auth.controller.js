const bcrypt = require("bcryptjs");
const { pool } = require("../config/database");
const { generateToken } = require("../utils/jwt");

// =====================================================
// LOGIN
// POST /api/auth/login
// =====================================================

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập đầy đủ tài khoản và mật khẩu",
      });
    }

    if (username.length > 100 || password.length > 128) {
      return res.status(400).json({
        success: false,
        message: "Thông tin đăng nhập không hợp lệ",
      });
    }

    const normalizedUsername = username.trim();

    const [users] = await pool.execute(
      `SELECT
        id,
        full_name,
        username,
        email,
        password_hash,
        role,
        status
       FROM users
       WHERE username = ?
       LIMIT 1`,
      [normalizedUsername],
    );

    if (!users.length) {
      return res.status(401).json({
        success: false,
        message: "Tài khoản hoặc mật khẩu không chính xác",
      });
    }

    const user = users[0];

    if (user.status !== "active") {
      return res.status(403).json({
        success: false,
        message: "Tài khoản đã bị khóa",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Tài khoản hoặc mật khẩu không chính xác",
      });
    }

    // Cập nhật lần đăng nhập
    await pool.execute(`UPDATE users SET last_login = NOW() WHERE id = ?`, [
      user.id,
    ]);

    // Tạo JWT
    const token = generateToken(user);

    const userData = {
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      email: user.email,
      role: user.role,
    };

    return res.json({
      success: true,
      message: "Đăng nhập thành công",
      data: {
        token,
        user: userData,
      },
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// GET CURRENT USER
// GET /api/auth/me
// =====================================================

const getMe = async (req, res) => {
  return res.json({
    success: true,
    data: {
      user: req.user,
    },
  });
};

module.exports = {
  login,
  getMe,
};
