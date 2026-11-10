const { pool } = require("../config/database");

const ALLOWED_PROTOCOLS = ["rtsp", "onvif", "ezviz", "upload", "other"];
const ALLOWED_STATUSES = ["active", "inactive", "error"];

const MASKED_VALUE = "********";

const SECRET_KEYS = [
  "password",
  "passwd",
  "pwd",
  "username",
  "token",
  "secret",
  "api_key",
  "apikey",
  "access_key",
  "private_key",
];

const ALLOWED_FIELDS = [
  "camera_code",
  "camera_name",
  "manufacturer",
  "model",
  "location",
  "description",
  "protocol",
  "connection_config",
  "status",
  "is_enabled",
];

function createError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// =========================================================
// PARSE / VALIDATE
// =========================================================

function parseConnectionConfig(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw createError("connection_config phải là JSON hợp lệ");
    }
  }

  if (typeof value !== "object" || Array.isArray(value) || value === null) {
    throw createError("connection_config phải là một object JSON");
  }

  return value;
}

function parseBoolean(value, fieldName = "is_enabled") {
  if ([true, 1, "1", "true"].includes(value)) return 1;
  if ([false, 0, "0", "false"].includes(value)) return 0;

  throw createError(`${fieldName} chỉ nhận true/false hoặc 1/0`);
}

function validateCameraData(data, isCreate = false) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw createError("Dữ liệu camera không hợp lệ");
  }

  const errors = [];

  if (isCreate && !String(data.camera_code || "").trim()) {
    errors.push("Mã camera không được để trống");
  }

  if (isCreate && !String(data.camera_name || "").trim()) {
    errors.push("Tên camera không được để trống");
  }

  if (
    data.protocol !== undefined &&
    !ALLOWED_PROTOCOLS.includes(data.protocol)
  ) {
    errors.push("Giao thức camera không hợp lệ");
  }

  if (data.status !== undefined && !ALLOWED_STATUSES.includes(data.status)) {
    errors.push("Trạng thái camera không hợp lệ");
  }

  if (data.is_enabled !== undefined) {
    try {
      parseBoolean(data.is_enabled);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length) {
    throw createError(errors.join(". "));
  }
}

// =========================================================
// SECURITY: REDACT CREDENTIALS
// =========================================================

function sanitizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return value;
  }

  try {
    const url = new URL(value);

    if (url.protocol === "rtsp:") {
      url.username = "";
      url.password = "";
      return url.toString();
    }

    return value;
  } catch {
    return "[URL không hợp lệ]";
  }
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === "object") {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();

      if (SECRET_KEYS.includes(lowerKey)) {
        result[key] = item ? MASKED_VALUE : item;
      } else if (["rtsp_url", "url"].includes(lowerKey)) {
        result[key] = sanitizeUrl(item);
      } else {
        result[key] = redactSecrets(item);
      }
    }

    return result;
  }

  return value;
}

function formatCamera(row) {
  if (!row) return null;

  let config = row.connection_config;

  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      config = null;
    }
  }

  return {
    ...row,
    is_enabled: Boolean(Number(row.is_enabled)),
    connection_config: redactSecrets(config),
  };
}

// =========================================================
// CONNECTION CONFIG: PRESERVE OLD SECRETS WHEN EDITING
// =========================================================

function restoreUrlCredentials(urlValue, username, password) {
  if (typeof urlValue !== "string" || !urlValue.trim()) {
    return urlValue;
  }

  try {
    const url = new URL(urlValue);

    if (url.protocol === "rtsp:") {
      if (username) url.username = username;
      if (password) url.password = password;
    }

    return url.toString();
  } catch {
    return urlValue;
  }
}

function mergeConnectionConfig(currentValue, incomingValue) {
  const incoming = parseConnectionConfig(incomingValue);

  if (!incoming) return null;

  const current = parseConnectionConfig(currentValue) || {};
  const merged = { ...incoming };

  // Giữ lại thông tin đăng nhập cũ nếu frontend gửi giá trị đã che
  // hoặc để trống khi người dùng không thay đổi mật khẩu.
  for (const key of SECRET_KEYS) {
    const incomingKey = Object.keys(merged).find(
      (item) => item.toLowerCase() === key,
    );

    const currentKey = Object.keys(current).find(
      (item) => item.toLowerCase() === key,
    );

    if (!incomingKey || !currentKey) continue;

    const value = merged[incomingKey];

    if (
      value === MASKED_VALUE ||
      value === "" ||
      value === null ||
      value === undefined
    ) {
      merged[incomingKey] = current[currentKey];
    }
  }

  const username = merged.username || current.username;
  const password = merged.password || current.password;

  for (const key of ["rtsp_url", "url"]) {
    if (typeof merged[key] !== "string") continue;

    merged[key] = restoreUrlCredentials(merged[key], username, password);
  }

  return merged;
}

// =========================================================
// RTSP URL HELPERS
// =========================================================

function splitRtspUrls(input) {
  if (!input) return [];

  const text = Array.isArray(input) ? input.join("\n") : String(input);

  const matches = text.match(/rtsp:\/\/[^\s,;]+/gi) || [];

  return [
    ...new Set(
      matches
        .map((url) => url.trim().replace(/[)\]}.,]+$/, ""))
        .filter(Boolean),
    ),
  ];
}

function parseRtspUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError("Link RTSP không được để trống");
  }

  try {
    const rawUrl = value.trim();
    const url = new URL(rawUrl);

    if (url.protocol !== "rtsp:") {
      throw createError("Chỉ hỗ trợ đường dẫn RTSP");
    }

    if (!url.hostname) {
      throw createError("Không tìm thấy địa chỉ camera");
    }

    const port = Number(url.port || 554);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw createError("Cổng RTSP không hợp lệ");
    }

    const username = decodeURIComponent(url.username || "");
    const password = decodeURIComponent(url.password || "");

    return {
      url: rawUrl,
      rtsp_url: rawUrl,
      host: url.hostname,
      port,
      username,
      password,
      stream_path: url.pathname || "/",
      protocol: "rtsp",
    };
  } catch (error) {
    if (error.statusCode) throw error;

    // Không đưa URL gốc vào lỗi vì có thể chứa mật khẩu.
    throw createError("Link RTSP không hợp lệ hoặc sai định dạng");
  }
}

function getRtspInput(data) {
  if (data.rtsp_urls) return data.rtsp_urls;
  if (data.rtsp_url) return data.rtsp_url;

  let config = data.connection_config;

  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      if (/rtsp:\/\//i.test(config)) return config;
      return null;
    }
  }

  if (config && typeof config === "object") {
    return config.rtsp_urls || config.rtsp_url || config.url || null;
  }

  return null;
}

// =========================================================
// DATABASE HELPERS
// =========================================================

async function getRawCameraById(id, executor = pool) {
  const [rows] = await executor.execute(
    `SELECT * FROM cameras WHERE id = ? LIMIT 1`,
    [id],
  );

  return rows[0] || null;
}

async function getCameraById(id) {
  const camera = await getRawCameraById(id);
  return formatCamera(camera);
}

// =========================================================
// GET CAMERA LIST
// =========================================================

async function getCameraList(query = {}) {
  const {
    keyword = "",
    status,
    protocol,
    is_enabled,
    page = 1,
    limit = 10,
  } = query;

  const currentPage = Math.max(parseInt(page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

  const offset = (currentPage - 1) * pageSize;

  const conditions = [];
  const params = [];

  const searchKeyword = String(keyword || "").trim();

  if (searchKeyword) {
    conditions.push(`
      (
        camera_code LIKE ?
        OR camera_name LIKE ?
        OR location LIKE ?
        OR manufacturer LIKE ?
      )
    `);

    const search = `%${searchKeyword}%`;

    params.push(search, search, search, search);
  }

  if (status) {
    if (!ALLOWED_STATUSES.includes(status)) {
      throw createError("Trạng thái camera không hợp lệ");
    }

    conditions.push("status = ?");
    params.push(status);
  }

  if (protocol) {
    if (!ALLOWED_PROTOCOLS.includes(protocol)) {
      throw createError("Giao thức camera không hợp lệ");
    }

    conditions.push("protocol = ?");
    params.push(protocol);
  }

  if (is_enabled !== undefined && is_enabled !== "") {
    conditions.push("is_enabled = ?");
    params.push(parseBoolean(is_enabled));
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM cameras ${where}`,
    params,
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        camera_code,
        camera_name,
        manufacturer,
        model,
        location,
        description,
        protocol,
        connection_config,
        status,
        is_enabled,
        last_connected_at,
        last_error,
        created_at,
        updated_at
      FROM cameras
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    [...params, pageSize, offset],
  );

  const total = Number(countRows[0].total);

  return {
    items: rows.map(formatCamera),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

// =========================================================
// CREATE CAMERA
// =========================================================

async function createCamera(data) {
  validateCameraData(data);

  const rtspInput = getRtspInput(data);

  // -------------------------------------------------------
  // CREATE ONE OR MULTIPLE RTSP CAMERAS
  // -------------------------------------------------------

  if (rtspInput) {
    const urls = splitRtspUrls(rtspInput);

    if (!urls.length) {
      throw createError("Vui lòng nhập ít nhất một link RTSP");
    }

    const parsedCameras = urls.map(parseRtspUrl);

    const connection = await pool.getConnection();
    const insertedIds = [];

    try {
      await connection.beginTransaction();

      const timestamp = Date.now();

      for (let i = 0; i < parsedCameras.length; i++) {
        const config = parsedCameras[i];

        const cameraCode =
          data.camera_code && parsedCameras.length === 1
            ? String(data.camera_code).trim()
            : `CAM-${timestamp}-${String(i + 1).padStart(3, "0")}`;

        const cameraName =
          data.camera_name && parsedCameras.length === 1
            ? String(data.camera_name).trim()
            : `Camera ${config.host}`;

        if (!cameraCode || !cameraName) {
          throw createError("Mã và tên camera không được để trống");
        }

        const [result] = await connection.execute(
          `
            INSERT INTO cameras (
              camera_code,
              camera_name,
              manufacturer,
              model,
              location,
              description,
              protocol,
              connection_config,
              status,
              is_enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            cameraCode,
            cameraName,
            data.manufacturer || "Khác",
            data.model || null,
            data.location || null,
            data.description || null,
            "rtsp",
            JSON.stringify(config),
            data.status || "inactive",
            data.is_enabled === undefined ? 1 : parseBoolean(data.is_enabled),
          ],
        );

        insertedIds.push(result.insertId);
      }

      await connection.commit();

      const cameras = await Promise.all(
        insertedIds.map((id) => getRawCameraById(id)),
      );

      return {
        total: cameras.length,
        cameras: cameras.map(formatCamera),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // -------------------------------------------------------
  // CREATE NORMAL CAMERA
  // -------------------------------------------------------

  validateCameraData(data, true);

  const cameraCode = String(data.camera_code).trim();
  const cameraName = String(data.camera_name).trim();

  const config = parseConnectionConfig(data.connection_config);

  const [result] = await pool.execute(
    `
      INSERT INTO cameras (
        camera_code,
        camera_name,
        manufacturer,
        model,
        location,
        description,
        protocol,
        connection_config,
        status,
        is_enabled
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      cameraCode,
      cameraName,
      data.manufacturer || "Khác",
      data.model || null,
      data.location || null,
      data.description || null,
      data.protocol || "rtsp",
      config ? JSON.stringify(config) : null,
      data.status || "inactive",
      data.is_enabled === undefined ? 1 : parseBoolean(data.is_enabled),
    ],
  );

  return getCameraById(result.insertId);
}

// =========================================================
// UPDATE CAMERA
// =========================================================

async function updateCamera(id, data) {
  validateCameraData(data);

  const current = await getRawCameraById(id);

  if (!current) {
    throw createError("Không tìm thấy camera", 404);
  }

  const updates = [];
  const values = [];

  for (const field of ALLOWED_FIELDS) {
    if (data[field] === undefined) continue;

    let value = data[field];

    if (field === "camera_code" || field === "camera_name") {
      value = String(value || "").trim();

      if (!value) {
        throw createError(`${field} không được để trống`);
      }
    }

    if (field === "connection_config") {
      value = mergeConnectionConfig(current.connection_config, value);

      value = value ? JSON.stringify(value) : null;
    }

    if (field === "is_enabled") {
      value = parseBoolean(value);
    }

    if (
      ["manufacturer", "model", "location", "description"].includes(field) &&
      value === ""
    ) {
      value = null;
    }

    updates.push(`${field} = ?`);
    values.push(value);
  }

  if (!updates.length) {
    throw createError("Không có thông tin cần cập nhật");
  }

  values.push(id);

  await pool.execute(
    `UPDATE cameras SET ${updates.join(", ")} WHERE id = ?`,
    values,
  );

  return getCameraById(id);
}

// =========================================================
// ENABLE / DISABLE CAMERA
// =========================================================

async function setCameraEnabled(id, enabled) {
  const current = await getRawCameraById(id);

  if (!current) {
    throw createError("Không tìm thấy camera", 404);
  }

  const value = parseBoolean(enabled);

  await pool.execute(`UPDATE cameras SET is_enabled = ? WHERE id = ?`, [
    value,
    id,
  ]);

  return getCameraById(id);
}

// =========================================================
// DELETE CAMERA
// =========================================================

async function deleteCamera(id) {
  const current = await getRawCameraById(id);

  if (!current) {
    throw createError("Không tìm thấy camera", 404);
  }

  const [eventRows] = await pool.execute(
    `
      SELECT COUNT(*) AS total
      FROM recognition_events
      WHERE camera_id = ?
    `,
    [id],
  );

  const [sessionRows] = await pool.execute(
    `
      SELECT COUNT(*) AS total
      FROM recognition_sessions
      WHERE camera_id = ?
    `,
    [id],
  );

  const eventCount = Number(eventRows[0].total);
  const sessionCount = Number(sessionRows[0].total);

  if (eventCount > 0 || sessionCount > 0) {
    throw createError(
      `Camera đã có dữ liệu nhận diện (${eventCount} sự kiện, ${sessionCount} phiên). Hãy tắt camera thay vì xóa để bảo toàn lịch sử.`,
      409,
    );
  }

  await pool.execute(`DELETE FROM cameras WHERE id = ?`, [id]);

  return true;
}

// =========================================================
// EXPORT
// =========================================================

module.exports = {
  getCameraById,
  getCameraList,
  createCamera,
  updateCamera,
  setCameraEnabled,
  deleteCamera,

  // Có thể dùng khi cần phân tích link RTSP ở controller.
  parseRtspUrl,
  splitRtspUrls,
};
