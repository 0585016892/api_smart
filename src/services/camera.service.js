const { pool } = require("../config/database");

const ALLOWED_PROTOCOLS = ["rtsp", "onvif", "ezviz", "upload", "other"];
const ALLOWED_STATUSES = ["active", "inactive", "error"];

const SECRET_KEYS = [
  "password",
  "passwd",
  "token",
  "secret",
  "api_key",
  "apikey",
  "access_key",
  "private_key",
];

function parseConnectionConfig(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw Object.assign(new Error("connection_config phải là JSON hợp lệ"), {
        statusCode: 400,
      });
    }
  }

  if (typeof value !== "object" || Array.isArray(value) || value === null) {
    throw Object.assign(
      new Error("connection_config phải là một object JSON"),
      { statusCode: 400 },
    );
  }

  return value;
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === "object") {
    const result = {};

    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.includes(key.toLowerCase())) {
        result[key] = item ? "********" : item;
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
    is_enabled: Boolean(row.is_enabled),
    connection_config: redactSecrets(config),
  };
}

function validateCameraData(data, isCreate = false) {
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

  if (
    data.is_enabled !== undefined &&
    ![true, false, 0, 1, "0", "1"].includes(data.is_enabled)
  ) {
    errors.push("is_enabled chỉ nhận true/false hoặc 1/0");
  }

  if (errors.length) {
    throw Object.assign(new Error(errors.join(". ")), {
      statusCode: 400,
    });
  }
}

async function getCameraById(id) {
  const [rows] = await pool.execute(
    `SELECT * FROM cameras WHERE id = ? LIMIT 1`,
    [id],
  );

  return rows[0] || null;
}

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

  if (keyword.trim()) {
    conditions.push(
      `(camera_code LIKE ? OR camera_name LIKE ? OR location LIKE ? OR manufacturer LIKE ?)`,
    );

    const search = `%${keyword.trim()}%`;
    params.push(search, search, search, search);
  }

  if (status && ALLOWED_STATUSES.includes(status)) {
    conditions.push("status = ?");
    params.push(status);
  }

  if (protocol && ALLOWED_PROTOCOLS.includes(protocol)) {
    conditions.push("protocol = ?");
    params.push(protocol);
  }

  if (is_enabled !== undefined && is_enabled !== "") {
    conditions.push("is_enabled = ?");
    params.push(Number(is_enabled));
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM cameras ${where}`,
    params,
  );

  const [rows] = await pool.execute(
    `SELECT
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
    LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return {
    items: rows.map(formatCamera),
    pagination: {
      page: currentPage,
      limit: pageSize,
      total: Number(countRows[0].total),
      totalPages: Math.ceil(Number(countRows[0].total) / pageSize),
    },
  };
}

/* =========================================================
   TÁCH NHIỀU LINK RTSP
========================================================= */

function splitRtspUrls(input) {
  if (!input) return [];

  const text = Array.isArray(input) ? input.join("\n") : String(input);

  const urls = text.match(/rtsp:\/\/[\s\S]*?(?=rtsp:\/\/|$)/gi) || [];

  return urls.map((url) => url.trim().replace(/[,;\s]+$/, "")).filter(Boolean);
}

/* =========================================================
   PHÂN TÍCH LINK RTSP
========================================================= */

function parseRtspUrl(value) {
  try {
    const url = new URL(value.trim());

    if (url.protocol !== "rtsp:") {
      throw new Error("Chỉ hỗ trợ đường dẫn RTSP");
    }

    if (!url.hostname) {
      throw new Error("Không tìm thấy địa chỉ IP camera");
    }

    return {
      // Giữ URL gốc để sử dụng kết nối
      url: value.trim(),
      rtsp_url: value.trim(),

      host: url.hostname,
      port: Number(url.port || 554),

      username: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),

      stream_path: url.pathname || "/",

      protocol: "rtsp",
    };
  } catch (error) {
    throw new Error(`Link RTSP không hợp lệ: ${value}`);
  }
}

/* =========================================================
   CREATE CAMERA
========================================================= */

async function createCamera(data) {
  // Hỗ trợ nhận link từ rtsp_urls, rtsp_url hoặc connection_config
  const rtspInput =
    data.rtsp_urls ||
    data.rtsp_url ||
    (typeof data.connection_config === "string" &&
    data.connection_config.includes("rtsp://")
      ? data.connection_config
      : null);

  // Nếu có link RTSP thì xử lý chế độ thêm nhiều camera
  if (rtspInput) {
    const urls = splitRtspUrls(rtspInput);

    if (!urls.length) {
      throw new Error("Vui lòng nhập ít nhất một link RTSP");
    }

    // Phân tích và kiểm tra toàn bộ link trước khi INSERT
    const parsedCameras = urls.map((url) => parseRtspUrl(url));

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

        const [result] = await connection.execute(
          `INSERT INTO cameras (
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            data.is_enabled === undefined
              ? 1
              : Number(Boolean(data.is_enabled)),
          ],
        );

        insertedIds.push(result.insertId);
      }

      await connection.commit();

      const cameras = await Promise.all(
        insertedIds.map((id) => getCameraById(id)),
      );

      return {
        total: cameras.length,
        cameras,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  // =======================================================
  // THÊM CAMERA THÔNG THƯỜNG - GIỮ NGUYÊN LOGIC CŨ
  // =======================================================

  validateCameraData(data, true);

  const cameraCode = String(data.camera_code).trim();
  const cameraName = String(data.camera_name).trim();

  const config = parseConnectionConfig(data.connection_config);

  const [result] = await pool.execute(
    `INSERT INTO cameras (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cameraCode,
      cameraName,
      data.manufacturer || "EZVIZ",
      data.model || null,
      data.location || null,
      data.description || null,
      data.protocol || "rtsp",
      config ? JSON.stringify(config) : null,
      data.status || "inactive",
      data.is_enabled === undefined ? 1 : Number(data.is_enabled),
    ],
  );

  return getCameraById(result.insertId);
}

async function updateCamera(id, data) {
  const current = await getCameraById(id);

  if (!current) {
    throw Object.assign(new Error("Không tìm thấy camera"), {
      statusCode: 404,
    });
  }

  validateCameraData(data);

  const allowedFields = [
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

  const updates = [];
  const values = [];

  for (const field of allowedFields) {
    if (data[field] === undefined) continue;

    let value = data[field];

    if (field === "camera_code" || field === "camera_name") {
      value = String(value).trim();

      if (!value) {
        throw Object.assign(new Error(`${field} không được để trống`), {
          statusCode: 400,
        });
      }
    }

    if (field === "connection_config") {
      const config = parseConnectionConfig(value);
      value = config ? JSON.stringify(config) : null;
    }

    if (field === "is_enabled") {
      value = Number(value);
    }

    updates.push(`${field} = ?`);
    values.push(value);
  }

  if (!updates.length) {
    throw Object.assign(new Error("Không có thông tin cần cập nhật"), {
      statusCode: 400,
    });
  }

  values.push(id);

  await pool.execute(
    `UPDATE cameras SET ${updates.join(", ")} WHERE id = ?`,
    values,
  );

  return getCameraById(id);
}

async function setCameraEnabled(id, enabled) {
  const current = await getCameraById(id);

  if (!current) {
    throw Object.assign(new Error("Không tìm thấy camera"), {
      statusCode: 404,
    });
  }

  await pool.execute(`UPDATE cameras SET is_enabled = ? WHERE id = ?`, [
    enabled ? 1 : 0,
    id,
  ]);

  return getCameraById(id);
}

async function deleteCamera(id) {
  const current = await getCameraById(id);

  if (!current) {
    throw Object.assign(new Error("Không tìm thấy camera"), {
      statusCode: 404,
    });
  }

  const [eventRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM recognition_events WHERE camera_id = ?`,
    [id],
  );

  const [sessionRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM recognition_sessions WHERE camera_id = ?`,
    [id],
  );

  const eventCount = Number(eventRows[0].total);
  const sessionCount = Number(sessionRows[0].total);

  if (eventCount > 0 || sessionCount > 0) {
    throw Object.assign(
      new Error(
        `Camera đã có dữ liệu nhận diện (${eventCount} sự kiện, ${sessionCount} phiên). Hãy tắt camera thay vì xóa để bảo toàn lịch sử.`,
      ),
      { statusCode: 409 },
    );
  }

  await pool.execute(`DELETE FROM cameras WHERE id = ?`, [id]);

  return true;
}

module.exports = {
  getCameraById,
  getCameraList,
  createCamera,
  updateCamera,
  setCameraEnabled,
  deleteCamera,
};
