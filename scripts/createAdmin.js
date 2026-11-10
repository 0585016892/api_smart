require("dotenv").config();

const bcrypt = require("bcryptjs");
const { pool } = require("../src/config/database");

const createAdmin = async () => {
  try {
    const fullName = process.env.ADMIN_NAME;
    const username = process.env.ADMIN_USERNAME;
    const email = process.env.ADMIN_EMAIL || null;
    const password = process.env.ADMIN_PASSWORD;

    if (!fullName || !username || !password) {
      throw new Error(
        "Vui lòng cấu hình ADMIN_NAME, ADMIN_USERNAME và ADMIN_PASSWORD trong .env",
      );
    }

    if (password.length < 12 || password.length > 128) {
      throw new Error("Mật khẩu Admin phải có từ 12 đến 128 ký tự");
    }

    if (username.length > 100) {
      throw new Error("Username tối đa 100 ký tự");
    }

    const [existing] = await pool.execute(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [username.trim()],
    );

    if (existing.length) {
      throw new Error("Username đã tồn tại");
    }

    const rounds = Number(process.env.BCRYPT_ROUNDS || 12);

    const passwordHash = await bcrypt.hash(password, rounds);

    const [result] = await pool.execute(
      `INSERT INTO users (
        full_name,
        username,
        email,
        password_hash,
        role,
        status
      ) VALUES (?, ?, ?, ?, 'admin', 'active')`,
      [fullName.trim(), username.trim(), email, passwordHash],
    );

    console.log("====================================");
    console.log("ADMIN ACCOUNT CREATED");
    console.log("ID:", result.insertId);
    console.log("Username:", username);
    console.log("Role: admin");
    console.log("====================================");
  } catch (error) {
    console.error("CREATE ADMIN ERROR:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

createAdmin();
