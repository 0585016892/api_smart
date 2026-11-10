const bcrypt = require("bcryptjs");
const { pool } = require("../config/database");

const ALLOWED_ROLES = ["admin", "operator", "viewer"];
const ALLOWED_STATUSES = ["active", "inactive"];

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseId(value) {
  const id = Number(value);

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw createError("ID tài khoản không hợp lệ");
  }

  return id;
}

function validatePassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128
  ) {
    throw createError("Mật khẩu phải có từ 8 đến 128 ký tự");
  }
}

function normalizeEmail(email) {
  if (email === undefined || email === null || email === "") {
    return null;
  }

  if (typeof email !== "string") {
    throw createError("Email không hợp lệ");
  }

  const value = email.trim().toLowerCase();

  if (value.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw createError("Địa chỉ email không hợp lệ");
  }

  return value;
}

function handleDuplicateError(error) {
  if (error.code === "ER_DUP_ENTRY") {
    throw createError("Username hoặc email đã được sử dụng", 409);
  }

  throw error;
}

function getPagination(query = {}) {
  const pageValue = Number(query.page);
  const limitValue = Number(query.limit);

  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;

  const limit =
    Number.isSafeInteger(limitValue) && limitValue > 0
      ? Math.min(limitValue, 100)
      : 20;

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

/**
 * Danh sách tài khoản.
 */
async function getUsers(query = {}) {
  const { page, limit, offset } = getPagination(query);
  const conditions = [];
  const params = [];

  if (query.keyword) {
    const keyword = `%${String(query.keyword).trim()}%`;

    conditions.push(`(
      full_name LIKE ?
      OR username LIKE ?
      OR email LIKE ?
    )`);

    params.push(keyword, keyword, keyword);
  }

  if (query.role) {
    if (!ALLOWED_ROLES.includes(query.role)) {
      throw createError("Vai trò không hợp lệ");
    }

    conditions.push("role = ?");
    params.push(query.role);
  }

  if (query.status) {
    if (!ALLOWED_STATUSES.includes(query.status)) {
      throw createError("Trạng thái tài khoản không hợp lệ");
    }

    conditions.push("status = ?");
    params.push(query.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM users ${where}`,
    params,
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        full_name,
        username,
        email,
        role,
        status,
        last_login,
        created_at,
        updated_at
      FROM users
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

  const total = Number(countRows[0]?.total || 0);

  return {
    items: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Chi tiết tài khoản.
 */
async function getUserById(id) {
  const userId = parseId(id);

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        full_name,
        username,
        email,
        role,
        status,
        last_login,
        created_at,
        updated_at
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
    [userId],
  );

  if (!rows.length) {
    throw createError("Không tìm thấy tài khoản", 404);
  }

  return rows[0];
}

/**
 * Tạo tài khoản.
 */
async function createUser(data = {}) {
  const fullName =
    typeof data.full_name === "string" ? data.full_name.trim() : "";

  const username =
    typeof data.username === "string" ? data.username.trim() : "";

  if (!fullName || fullName.length > 150) {
    throw createError("Họ và tên không hợp lệ");
  }

  if (
    !username ||
    username.length < 3 ||
    username.length > 100 ||
    !/^[a-zA-Z0-9_.-]+$/.test(username)
  ) {
    throw createError(
      "Username phải từ 3 đến 100 ký tự, chỉ gồm chữ, số, dấu chấm, gạch ngang hoặc gạch dưới",
    );
  }

  validatePassword(data.password);

  const email = normalizeEmail(data.email);

  const role = data.role || "viewer";

  if (!ALLOWED_ROLES.includes(role)) {
    throw createError("Vai trò không hợp lệ");
  }

  const passwordHash = await bcrypt.hash(data.password, 12);

  try {
    const [result] = await pool.execute(
      `
        INSERT INTO users (
          full_name,
          username,
          email,
          password_hash,
          role,
          status
        )
        VALUES (?, ?, ?, ?, ?, 'active')
      `,
      [fullName, username, email, passwordHash, role],
    );

    return getUserById(result.insertId);
  } catch (error) {
    handleDuplicateError(error);
  }
}

/**
 * Cập nhật thông tin và vai trò.
 */
async function updateUser(id, data = {}, actor = {}) {
  const userId = parseId(id);

  const fields = [];
  const params = [];

  if (data.full_name !== undefined) {
    if (
      typeof data.full_name !== "string" ||
      !data.full_name.trim() ||
      data.full_name.trim().length > 150
    ) {
      throw createError("Họ và tên không hợp lệ");
    }

    fields.push("full_name = ?");
    params.push(data.full_name.trim());
  }

  if (data.email !== undefined) {
    fields.push("email = ?");
    params.push(normalizeEmail(data.email));
  }

  if (data.role !== undefined) {
    if (!ALLOWED_ROLES.includes(data.role)) {
      throw createError("Vai trò không hợp lệ");
    }

    if (Number(actor.id) === userId && data.role !== "admin") {
      throw createError("Bạn không thể tự hạ quyền tài khoản của mình");
    }

    fields.push("role = ?");
    params.push(data.role);
  }

  if (!fields.length) {
    throw createError("Không có thông tin hợp lệ để cập nhật");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [targets] = await connection.execute(
      `SELECT id, role, status FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );

    if (!targets.length) {
      throw createError("Không tìm thấy tài khoản", 404);
    }

    const target = targets[0];

    const isRemovingActiveAdmin =
      target.role === "admin" &&
      target.status === "active" &&
      data.role !== undefined &&
      data.role !== "admin";

    if (isRemovingActiveAdmin) {
      const [admins] = await connection.execute(
        `
          SELECT id
          FROM users
          WHERE role = 'admin' AND status = 'active'
          FOR UPDATE
        `,
      );

      if (admins.length <= 1) {
        throw createError("Không thể hạ quyền admin cuối cùng đang hoạt động");
      }
    }

    await connection.execute(
      `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
      [...params, userId],
    );

    await connection.commit();

    return getUserById(userId);
  } catch (error) {
    await connection.rollback();
    handleDuplicateError(error);
  } finally {
    connection.release();
  }
}

/**
 * Khóa hoặc mở khóa tài khoản.
 */
async function updateUserStatus(id, status, actor = {}) {
  const userId = parseId(id);

  if (!ALLOWED_STATUSES.includes(status)) {
    throw createError("Trạng thái tài khoản không hợp lệ");
  }

  if (Number(actor.id) === userId && status !== "active") {
    throw createError("Bạn không thể tự khóa tài khoản của mình");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [targets] = await connection.execute(
      `SELECT id, role, status FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );

    if (!targets.length) {
      throw createError("Không tìm thấy tài khoản", 404);
    }

    const target = targets[0];

    if (
      target.role === "admin" &&
      target.status === "active" &&
      status === "inactive"
    ) {
      const [admins] = await connection.execute(
        `
          SELECT id
          FROM users
          WHERE role = 'admin' AND status = 'active'
          FOR UPDATE
        `,
      );

      if (admins.length <= 1) {
        throw createError("Không thể khóa admin cuối cùng đang hoạt động");
      }
    }

    await connection.execute(`UPDATE users SET status = ? WHERE id = ?`, [
      status,
      userId,
    ]);

    await connection.commit();

    return getUserById(userId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Admin đặt lại mật khẩu cho tài khoản khác.
 */
async function resetUserPassword(id, password) {
  const userId = parseId(id);

  validatePassword(password);

  const passwordHash = await bcrypt.hash(password, 12);

  const [result] = await pool.execute(
    `UPDATE users SET password_hash = ? WHERE id = ?`,
    [passwordHash, userId],
  );

  if (!result.affectedRows) {
    throw createError("Không tìm thấy tài khoản", 404);
  }

  return getUserById(userId);
}

/**
 * Người dùng tự đổi mật khẩu.
 */
async function changeOwnPassword(userId, currentPassword, newPassword) {
  const id = parseId(userId);

  if (typeof currentPassword !== "string" || !currentPassword) {
    throw createError("Vui lòng nhập mật khẩu hiện tại");
  }

  validatePassword(newPassword);

  if (currentPassword === newPassword) {
    throw createError("Mật khẩu mới phải khác mật khẩu hiện tại");
  }

  const [rows] = await pool.execute(
    `SELECT password_hash FROM users WHERE id = ? LIMIT 1`,
    [id],
  );

  if (!rows.length) {
    throw createError("Không tìm thấy tài khoản", 404);
  }

  const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);

  if (!valid) {
    throw createError("Mật khẩu hiện tại không chính xác", 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await pool.execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [
    passwordHash,
    id,
  ]);

  return true;
}

module.exports = {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  updateUserStatus,
  resetUserPassword,
  changeOwnPassword,
};
