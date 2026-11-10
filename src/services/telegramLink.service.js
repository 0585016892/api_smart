const crypto = require("crypto");
const { pool } = require("../config/database");

const LINK_EXPIRES_MINUTES = 10;

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ======================================================
// TẠO MÃ LIÊN KẾT
// ======================================================

async function createLinkCode(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = hashToken(token);

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Hủy các mã chưa sử dụng trước đó của tài khoản.
    await connection.query(
      `
        UPDATE telegram_link_tokens
        SET used_at = NOW()
        WHERE user_id = ?
          AND used_at IS NULL
      `,
      [userId],
    );

    await connection.query(
      `
        INSERT INTO telegram_link_tokens (
          user_id,
          token_hash,
          expires_at
        )
        VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
      `,
      [userId, tokenHash, LINK_EXPIRES_MINUTES],
    );

    await connection.commit();

    return {
      code: token,
      expires_in: LINK_EXPIRES_MINUTES * 60,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// ======================================================
// TRẠNG THÁI LIÊN KẾT
// ======================================================

async function getLinkStatus(userId) {
  const [rows] = await pool.query(
    `
      SELECT
        id,
        telegram_id,
        username,
        first_name,
        notify_known,
        notify_unknown,
        is_active,
        linked_at
      FROM telegram_user_links
      WHERE user_id = ?
      LIMIT 1
    `,
    [userId],
  );

  if (!rows.length) {
    return {
      linked: false,
      data: null,
    };
  }

  const row = rows[0];

  return {
    linked: true,
    data: {
      telegram_id: row.telegram_id,
      username: row.username,
      first_name: row.first_name,
      notify_known: Boolean(row.notify_known),
      notify_unknown: Boolean(row.notify_unknown),
      is_active: Boolean(row.is_active),
      linked_at: row.linked_at,
    },
  };
}

// ======================================================
// HỦY LIÊN KẾT
// ======================================================

async function unlinkTelegram(userId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(
      `DELETE FROM telegram_user_links WHERE user_id = ?`,
      [userId],
    );

    await connection.query(
      `
        UPDATE telegram_link_tokens
        SET used_at = NOW()
        WHERE user_id = ?
          AND used_at IS NULL
      `,
      [userId],
    );

    await connection.commit();

    return {
      unlinked: true,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// ======================================================
// CẬP NHẬT TÙY CHỌN THÔNG BÁO
// ======================================================

async function updatePreferences(userId, data = {}) {
  const allowedFields = ["notify_known", "notify_unknown", "is_active"];

  const updates = [];
  const values = [];

  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(data[field] ? 1 : 0);
    }
  }

  if (!updates.length) {
    throw createError("Không có thông tin cần cập nhật");
  }

  values.push(userId);

  const [result] = await pool.query(
    `
      UPDATE telegram_user_links
      SET ${updates.join(", ")}
      WHERE user_id = ?
    `,
    values,
  );

  if (!result.affectedRows) {
    throw createError("Tài khoản chưa liên kết Telegram", 404);
  }

  return getLinkStatus(userId);
}

// ======================================================
// BOT XỬ LÝ /START MÃ_LIÊN_KẾT
// ======================================================

async function completeTelegramLink({
  token,
  telegramId,
  chatId,
  username,
  firstName,
}) {
  if (!token || !/^[a-f0-9]{48}$/i.test(token)) {
    throw createError("Mã liên kết không hợp lệ hoặc đã hết hạn");
  }

  if (!telegramId || !chatId) {
    throw createError("Thông tin Telegram không hợp lệ");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [tokens] = await connection.query(
      `
        SELECT
          id,
          user_id,
          expires_at,
          used_at
        FROM telegram_link_tokens
        WHERE token_hash = ?
        LIMIT 1
        FOR UPDATE
      `,
      [hashToken(token)],
    );

    if (!tokens.length) {
      throw createError("Mã liên kết không tồn tại");
    }

    const linkToken = tokens[0];

    if (linkToken.used_at) {
      throw createError("Mã liên kết đã được sử dụng");
    }

    const [expired] = await connection.query(
      `
        SELECT id
        FROM telegram_link_tokens
        WHERE id = ?
          AND expires_at <= NOW()
        LIMIT 1
      `,
      [linkToken.id],
    );

    if (expired.length) {
      throw createError("Mã liên kết đã hết hạn. Vui lòng tạo mã mới");
    }

    // Không cho một Telegram liên kết với hai tài khoản hệ thống.
    const [existingTelegram] = await connection.query(
      `
        SELECT user_id
        FROM telegram_user_links
        WHERE telegram_id = ?
          AND user_id <> ?
        LIMIT 1
      `,
      [String(telegramId), linkToken.user_id],
    );

    if (existingTelegram.length) {
      throw createError(
        "Tài khoản Telegram này đã liên kết với một tài khoản khác",
      );
    }

    await connection.query(
      `
        INSERT INTO telegram_user_links (
          user_id,
          telegram_id,
          chat_id,
          username,
          first_name,
          notify_known,
          notify_unknown,
          is_active,
          linked_at
        )
        VALUES (?, ?, ?, ?, ?, 1, 1, 1, NOW())
        ON DUPLICATE KEY UPDATE
          telegram_id = VALUES(telegram_id),
          chat_id = VALUES(chat_id),
          username = VALUES(username),
          first_name = VALUES(first_name),
          is_active = 1,
          linked_at = NOW()
      `,
      [
        linkToken.user_id,
        String(telegramId),
        String(chatId),
        username || null,
        firstName || null,
      ],
    );

    await connection.query(
      `
        UPDATE telegram_link_tokens
        SET used_at = NOW()
        WHERE id = ?
      `,
      [linkToken.id],
    );

    await connection.commit();

    return {
      success: true,
      user_id: linkToken.user_id,
      message: "Liên kết Telegram thành công",
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  createLinkCode,
  getLinkStatus,
  unlinkTelegram,
  updatePreferences,
  completeTelegramLink,
};
