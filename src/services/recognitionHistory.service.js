const fs = require("fs");
const path = require("path");
const { pool } = require("../config/database");

// =====================================================
// CONFIGURATION
// =====================================================

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || "uploads");
const RECOGNITION_ROOT = path.resolve(UPLOAD_ROOT, "recognition");

const EVENT_STATUSES = ["known", "unknown", "uncertain"];
const DIRECTIONS = ["entry", "exit", "unknown"];
const SESSION_STATUSES = ["open", "closed"];

const MAX_PAGE_SIZE = 100;
const MAX_DELETE_IDS = 500;

// =====================================================
// COMMON HELPERS
// =====================================================

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parsePositiveInteger(value, fieldName = "id") {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    !/^\d+$/.test(String(value))
  ) {
    throw createError(`${fieldName} không hợp lệ`);
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    throw createError(`${fieldName} không hợp lệ`);
  }

  return number;
}

function validateDate(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const dateString = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw createError(`${fieldName} phải có định dạng YYYY-MM-DD`);
  }

  const date = new Date(`${dateString}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== dateString
  ) {
    throw createError(`${fieldName} không phải ngày hợp lệ`);
  }

  return dateString;
}

function buildPagination(query = {}) {
  const rawPage = Number(query.page);
  const rawLimit = Number(query.limit);

  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const limit =
    Number.isSafeInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_PAGE_SIZE)
      : 20;

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function validateEnum(value, allowed, message) {
  if (!value) return null;

  if (!allowed.includes(value)) {
    throw createError(message);
  }

  return value;
}

function buildDateConditions(conditions, params, fromDate, toDate, column) {
  if (fromDate && toDate && fromDate > toDate) {
    throw createError("Ngày bắt đầu không được lớn hơn ngày kết thúc");
  }

  if (fromDate) {
    conditions.push(`${column} >= ?`);
    params.push(`${fromDate} 00:00:00`);
  }

  if (toDate) {
    conditions.push(`${column} < DATE_ADD(?, INTERVAL 1 DAY)`);
    params.push(`${toDate} 00:00:00`);
  }
}

function buildKeywordCondition(conditions, params, keyword, columns) {
  const value = String(keyword || "").trim();

  if (!value) return;

  const searchValue = `%${value}%`;

  conditions.push(`
    (
      ${columns.map((column) => `${column} LIKE ?`).join(" OR ")}
    )
  `);

  columns.forEach(() => {
    params.push(searchValue);
  });
}

// =====================================================
// SNAPSHOT PATH HELPERS
// =====================================================

/**
 * Chỉ cho phép đường dẫn:
 * recognition/YYYY/MM/DD/filename.(jpg|jpeg|png|webp)
 *
 * Không cho phép:
 * - Đường dẫn tuyệt đối.
 * - ../ hoặc path traversal.
 * - Đường dẫn ra ngoài thư mục recognition.
 * - File có phần mở rộng không hợp lệ.
 */
function resolveSnapshotPath(relativePath) {
  if (!relativePath || typeof relativePath !== "string") {
    return null;
  }

  const normalized = relativePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  const validPattern =
    /^recognition\/\d{4}\/\d{2}\/\d{2}\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i;

  if (!validPattern.test(normalized)) {
    return null;
  }

  const absolutePath = path.resolve(UPLOAD_ROOT, normalized);

  const relative = path.relative(RECOGNITION_ROOT, absolutePath);

  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  return absolutePath;
}

/**
 * Xóa file an toàn.
 * Không ảnh hưởng đến quá trình xóa database nếu file không tồn tại.
 */
async function deleteRecognitionFile(relativePath) {
  const absolutePath = resolveSnapshotPath(relativePath);

  if (!absolutePath) return false;

  try {
    await fs.promises.unlink(absolutePath);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("DELETE RECOGNITION FILE ERROR:", absolutePath, error);
    }

    return false;
  }
}

// =====================================================
// RECOGNITION EVENTS FILTERS
// =====================================================

function buildEventFilters(query = {}) {
  const conditions = [];
  const params = [];

  const status = validateEnum(
    query.status,
    EVENT_STATUSES,
    "Trạng thái nhận diện không hợp lệ",
  );

  if (status) {
    conditions.push("e.recognition_status = ?");
    params.push(status);
  }

  const direction = validateEnum(
    query.direction,
    DIRECTIONS,
    "Hướng di chuyển không hợp lệ",
  );

  if (direction) {
    conditions.push("e.direction = ?");
    params.push(direction);
  }

  if (query.person_id) {
    conditions.push("e.person_id = ?");
    params.push(parsePositiveInteger(query.person_id, "person_id"));
  }

  if (query.camera_id) {
    conditions.push("e.camera_id = ?");
    params.push(parsePositiveInteger(query.camera_id, "camera_id"));
  }

  const fromDate = validateDate(query.from, "from");
  const toDate = validateDate(query.to, "to");

  buildDateConditions(conditions, params, fromDate, toDate, "e.event_at");

  buildKeywordCondition(conditions, params, query.keyword, [
    "e.event_code",
    "p.full_name",
    "p.person_code",
    "c.camera_name",
    "c.camera_code",
  ]);

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

// =====================================================
// RECOGNITION EVENTS
// =====================================================

/**
 * Danh sách sự kiện nhận diện có phân trang và bộ lọc.
 */
async function listRecognitionEvents(query = {}) {
  const { page, limit, offset } = buildPagination(query);

  const { whereSql, params } = buildEventFilters(query);

  const [countRows] = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM recognition_events e
      LEFT JOIN persons p ON p.id = e.person_id
      LEFT JOIN cameras c ON c.id = e.camera_id
      ${whereSql}
    `,
    params,
  );

  const [rows] = await pool.query(
    `
      SELECT
        e.id,
        e.event_code,
        e.camera_id,
        c.camera_code,
        c.camera_name,
        c.location AS camera_location,

        e.person_id,
        p.person_code,
        p.full_name,
        p.category,

        e.recognition_status,
        e.direction,
        e.confidence,

        e.snapshot_path,
        e.face_image_path,
        e.face_count,

        e.notification_sent,
        e.notification_sent_at,

        e.event_at,
        e.created_at

      FROM recognition_events e

      LEFT JOIN persons p
        ON p.id = e.person_id

      LEFT JOIN cameras c
        ON c.id = e.camera_id

      ${whereSql}

      ORDER BY e.event_at DESC, e.id DESC

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
      total_pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Chi tiết một sự kiện nhận diện.
 */
async function getRecognitionEventById(id) {
  const eventId = parsePositiveInteger(id, "event_id");

  const [rows] = await pool.query(
    `
      SELECT
        e.*,

        p.person_code,
        p.full_name,
        p.phone,
        p.email,
        p.category,
        p.avatar_path,

        c.camera_code,
        c.camera_name,
        c.location AS camera_location,
        c.protocol AS camera_protocol

      FROM recognition_events e

      LEFT JOIN persons p
        ON p.id = e.person_id

      LEFT JOIN cameras c
        ON c.id = e.camera_id

      WHERE e.id = ?

      LIMIT 1
    `,
    [eventId],
  );

  return rows[0] || null;
}

// =====================================================
// RECOGNITION SESSIONS FILTERS
// =====================================================

function buildSessionFilters(query = {}) {
  const conditions = [];
  const params = [];

  const status = validateEnum(
    query.status,
    EVENT_STATUSES,
    "Trạng thái nhận diện không hợp lệ",
  );

  if (status) {
    conditions.push("s.recognition_status = ?");
    params.push(status);
  }

  const sessionStatus = validateEnum(
    query.session_status,
    SESSION_STATUSES,
    "Trạng thái phiên không hợp lệ",
  );

  if (sessionStatus) {
    conditions.push("s.session_status = ?");
    params.push(sessionStatus);
  }

  if (query.person_id) {
    conditions.push("s.person_id = ?");
    params.push(parsePositiveInteger(query.person_id, "person_id"));
  }

  if (query.camera_id) {
    conditions.push("s.camera_id = ?");
    params.push(parsePositiveInteger(query.camera_id, "camera_id"));
  }

  const fromDate = validateDate(query.from, "from");
  const toDate = validateDate(query.to, "to");

  buildDateConditions(conditions, params, fromDate, toDate, "s.check_in_at");

  buildKeywordCondition(conditions, params, query.keyword, [
    "s.session_code",
    "p.full_name",
    "p.person_code",
    "c.camera_name",
    "c.camera_code",
  ]);

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

// =====================================================
// AUTO CLOSE EXPIRED SESSIONS
// =====================================================

/**
 * Tự động đóng phiên nhận diện nếu không còn nhìn thấy
 * người đó trong khoảng thời gian cấu hình.
 *
 * Mặc định: 10 phút.
 */
async function closeExpiredRecognitionSessions() {
  const configuredTimeout = Number(
    process.env.RECOGNITION_SESSION_TIMEOUT_MINUTES || 10,
  );

  const timeoutMinutes =
    Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, 1440)
      : 10;

  const [result] = await pool.query(
    `
      UPDATE recognition_sessions

      SET
        session_status = 'closed',

        check_out_at = DATE_ADD(
          last_seen_at,
          INTERVAL ? MINUTE
        )

      WHERE
        session_status = 'open'

        AND last_seen_at IS NOT NULL

        AND last_seen_at < DATE_SUB(
          NOW(),
          INTERVAL ? MINUTE
        )
    `,
    [timeoutMinutes, timeoutMinutes],
  );

  return result.affectedRows;
}

// =====================================================
// RECOGNITION SESSIONS
// =====================================================

/**
 * Danh sách phiên nhận diện.
 */
async function listRecognitionSessions(query = {}) {
  await closeExpiredRecognitionSessions();

  const { page, limit, offset } = buildPagination(query);

  const { whereSql, params } = buildSessionFilters(query);

  const [countRows] = await pool.query(
    `
      SELECT COUNT(*) AS total

      FROM recognition_sessions s

      LEFT JOIN persons p
        ON p.id = s.person_id

      LEFT JOIN cameras c
        ON c.id = s.camera_id

      ${whereSql}
    `,
    params,
  );

  const [rows] = await pool.query(
    `
      SELECT
        s.id,
        s.session_code,

        s.person_id,
        p.person_code,
        p.full_name,
        p.category,

        s.camera_id,
        c.camera_code,
        c.camera_name,

        s.recognition_status,

        s.check_in_at,
        s.last_seen_at,
        s.check_out_at,

        s.snapshot_path,
        s.event_count,
        s.session_status,

        s.created_at,
        s.updated_at

      FROM recognition_sessions s

      LEFT JOIN persons p
        ON p.id = s.person_id

      LEFT JOIN cameras c
        ON c.id = s.camera_id

      ${whereSql}

      ORDER BY s.check_in_at DESC, s.id DESC

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
      total_pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Chi tiết một phiên nhận diện.
 */
async function getRecognitionSessionById(id) {
  const sessionId = parsePositiveInteger(id, "session_id");

  const [rows] = await pool.query(
    `
      SELECT
        s.*,

        p.person_code,
        p.full_name,
        p.phone,
        p.email,
        p.category,
        p.avatar_path,

        c.camera_code,
        c.camera_name,
        c.location AS camera_location

      FROM recognition_sessions s

      LEFT JOIN persons p
        ON p.id = s.person_id

      LEFT JOIN cameras c
        ON c.id = s.camera_id

      WHERE s.id = ?

      LIMIT 1
    `,
    [sessionId],
  );

  return rows[0] || null;
}

// =====================================================
// BULK DELETE RECOGNITION RECORDS
// =====================================================

/**
 * Xóa nhiều sự kiện hoặc phiên nhận diện.
 *
 * Quy trình:
 * 1. Validate danh sách ID.
 * 2. Bắt đầu transaction.
 * 3. Lấy thông tin file ảnh.
 * 4. Xóa dữ liệu database.
 * 5. Commit transaction.
 * 6. Xóa file ảnh sau khi commit thành công.
 */
async function bulkDeleteRecognitionRecords(ids, type) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw createError("Vui lòng chọn ít nhất một bản ghi");
  }

  if (ids.length > MAX_DELETE_IDS) {
    throw createError(`Chỉ được xóa tối đa ${MAX_DELETE_IDS} bản ghi mỗi lần`);
  }

  const normalizedIds = [
    ...new Set(ids.map((id) => parsePositiveInteger(id, "id"))),
  ];

  // Chỉ sử dụng tên bảng được định nghĩa sẵn.
  const tableConfig = {
    events: {
      table: "recognition_events",
      columns: ["snapshot_path", "face_image_path"],
    },
    sessions: {
      table: "recognition_sessions",
      columns: ["snapshot_path"],
    },
  };

  const config = tableConfig[type];

  if (!config) {
    throw createError("Loại dữ liệu không hợp lệ");
  }

  const { table, columns } = config;

  const connection = await pool.getConnection();

  let deletedRows = [];
  let deletedCount = 0;

  try {
    await connection.beginTransaction();

    const placeholders = normalizedIds.map(() => "?").join(",");

    // Lấy danh sách bản ghi và đường dẫn ảnh.
    const [rows] = await connection.query(
      `
        SELECT
          id,
          ${columns.join(", ")}

        FROM ${table}

        WHERE id IN (${placeholders})

        FOR UPDATE
      `,
      normalizedIds,
    );

    deletedRows = rows;

    // Xóa dữ liệu.
    const [result] = await connection.query(
      `
        DELETE FROM ${table}

        WHERE id IN (${placeholders})
      `,
      normalizedIds,
    );

    deletedCount = result.affectedRows;

    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error("ROLLBACK RECOGNITION DELETE ERROR:", rollbackError);
    }

    throw error;
  } finally {
    connection.release();
  }

  // Chỉ xóa file sau khi transaction thành công.
  // Set giúp tránh xóa trùng một file nhiều lần.
  const filePaths = new Set();

  for (const row of deletedRows) {
    for (const column of columns) {
      if (row[column]) {
        filePaths.add(row[column]);
      }
    }
  }

  const fileResults = await Promise.allSettled(
    [...filePaths].map((filePath) => deleteRecognitionFile(filePath)),
  );

  const deletedFiles = fileResults.filter(
    (result) => result.status === "fulfilled" && result.value === true,
  ).length;

  const failedFiles = fileResults.filter(
    (result) => result.status === "rejected",
  ).length;

  return {
    requested: normalizedIds.length,
    found: deletedRows.length,
    deleted: deletedCount,
    deleted_files: deletedFiles,
    failed_files: failedFiles,
    ids: deletedRows.map((row) => row.id),
  };
}

// =====================================================
// BULK DELETE EVENTS
// =====================================================

async function bulkDeleteRecognitionEvents(ids) {
  return bulkDeleteRecognitionRecords(ids, "events");
}

// =====================================================
// BULK DELETE SESSIONS
// =====================================================

async function bulkDeleteRecognitionSessions(ids) {
  return bulkDeleteRecognitionRecords(ids, "sessions");
}

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  // Events
  listRecognitionEvents,
  getRecognitionEventById,
  bulkDeleteRecognitionEvents,

  // Sessions
  listRecognitionSessions,
  getRecognitionSessionById,
  bulkDeleteRecognitionSessions,

  // Helpers
  resolveSnapshotPath,
  deleteRecognitionFile,
  closeExpiredRecognitionSessions,

  // Filters (nếu Controller cần sử dụng)
  buildEventFilters,
  buildSessionFilters,
};
