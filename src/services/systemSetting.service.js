const { pool } = require("../config/database");

const SETTING_DEFINITIONS = {
  system_name: {
    group: "general",
    type: "string",
    description: "Tên hệ thống",
    validate: (value) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 100,
  },

  timezone: {
    group: "general",
    type: "string",
    description: "Múi giờ hệ thống",
    validate: (value) => {
      if (typeof value !== "string" || !value.trim()) return false;

      try {
        new Intl.DateTimeFormat("vi-VN", {
          timeZone: value,
        });
        return true;
      } catch {
        return false;
      }
    },
  },

  recognition_threshold: {
    group: "recognition",
    type: "number",
    description: "Ngưỡng tin cậy nhận diện từ 0 đến 1",
    validate: (value) =>
      Number.isFinite(Number(value)) &&
      Number(value) >= 0 &&
      Number(value) <= 1,
  },

  session_timeout_minutes: {
    group: "recognition",
    type: "number",
    description: "Thời gian đóng phiên khi không còn phát hiện",
    validate: (value) =>
      Number.isInteger(Number(value)) &&
      Number(value) >= 1 &&
      Number(value) <= 1440,
  },

  snapshot_retention_days: {
    group: "storage",
    type: "number",
    description: "Số ngày lưu ảnh nhận diện",
    validate: (value) =>
      Number.isInteger(Number(value)) &&
      Number(value) >= 1 &&
      Number(value) <= 3650,
  },

  max_upload_size_mb: {
    group: "storage",
    type: "number",
    description: "Dung lượng upload tối đa tính bằng MB",
    validate: (value) =>
      Number.isInteger(Number(value)) &&
      Number(value) >= 1 &&
      Number(value) <= 100,
  },
};

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatSetting(row) {
  let value = row.setting_value;

  if (row.value_type === "number") {
    value = Number(value);
  }

  if (row.value_type === "boolean") {
    value = value === "true" || value === "1";
  }

  if (row.value_type === "json") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }

  return {
    key: row.setting_key,
    value,
    group: row.setting_group,
    type: row.value_type,
    description: row.description,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  };
}

async function getAllSettings() {
  const [rows] = await pool.execute(`
    SELECT
      setting_key,
      setting_value,
      setting_group,
      value_type,
      description,
      updated_by,
      updated_at
    FROM system_settings
    ORDER BY setting_group ASC, setting_key ASC
  `);

  const settings = rows.map(formatSetting);

  const grouped = {};

  for (const setting of settings) {
    if (!grouped[setting.group]) {
      grouped[setting.group] = [];
    }

    grouped[setting.group].push(setting);
  }

  return {
    settings,
    grouped,
  };
}

async function getSetting(key) {
  const [rows] = await pool.execute(
    `
      SELECT
        setting_key,
        setting_value,
        setting_group,
        value_type,
        description,
        updated_by,
        updated_at
      FROM system_settings
      WHERE setting_key = ?
      LIMIT 1
    `,
    [key],
  );

  if (!rows.length) {
    throw createError("Không tìm thấy cấu hình", 404);
  }

  return formatSetting(rows[0]);
}

/**
 * Cập nhật nhiều cấu hình trong cùng một transaction.
 *
 * Payload:
 * {
 *   recognition_threshold: 0.7,
 *   session_timeout_minutes: 15
 * }
 */
async function updateSettings(data = {}, userId = null) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length === 0
  ) {
    throw createError("Vui lòng cung cấp cấu hình cần cập nhật");
  }

  const entries = Object.entries(data);

  for (const [key, value] of entries) {
    const definition = SETTING_DEFINITIONS[key];

    if (!definition) {
      throw createError(`Không được phép cập nhật cấu hình: ${key}`);
    }

    if (!definition.validate(value)) {
      throw createError(`Giá trị cấu hình ${key} không hợp lệ`);
    }
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const [key, value] of entries) {
      const definition = SETTING_DEFINITIONS[key];

      const normalizedValue =
        definition.type === "number"
          ? String(Number(value))
          : String(value).trim();

      await connection.execute(
        `
          INSERT INTO system_settings (
            setting_key,
            setting_value,
            setting_group,
            value_type,
            description,
            updated_by
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            setting_value = VALUES(setting_value),
            setting_group = VALUES(setting_group),
            value_type = VALUES(value_type),
            description = VALUES(description),
            updated_by = VALUES(updated_by)
        `,
        [
          key,
          normalizedValue,
          definition.group,
          definition.type,
          definition.description,
          userId,
        ],
      );
    }

    await connection.commit();

    return getAllSettings();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  getAllSettings,
  getSetting,
  updateSettings,
};
