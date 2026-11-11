const path = require("path");
const { pool } = require("../config/database");

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || "uploads");
const RECOGNITION_ROOT = path.resolve(UPLOAD_ROOT, "recognition");

function parsePositiveInteger(value, fieldName) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    const error = new Error(`${fieldName} không hợp lệ`);
    error.statusCode = 400;
    throw error;
  }

  return number;
}

function validateDate(value, fieldName) {
  if (!value) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const error = new Error(`${fieldName} phải có định dạng YYYY-MM-DD`);
    error.statusCode = 400;
    throw error;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    const error = new Error(`${fieldName} không phải ngày hợp lệ`);
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function buildPagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(query.limit, 10) || 20),
  );

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function buildEventFilters(query) {
  const conditions = [];
  const params = [];

  if (query.status) {
    const allowed = ["known", "unknown", "uncertain"];

    if (!allowed.includes(query.status)) {
      const error = new Error("Trạng thái nhận diện không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("e.recognition_status = ?");
    params.push(query.status);
  }

  if (query.direction) {
    const allowed = ["entry", "exit", "unknown"];

    if (!allowed.includes(query.direction)) {
      const error = new Error("Hướng di chuyển không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("e.direction = ?");
    params.push(query.direction);
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

  if (fromDate) {
    conditions.push("e.event_at >= ?");
    params.push(`${fromDate} 00:00:00`);
  }

  if (toDate) {
    conditions.push("e.event_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${toDate} 00:00:00`);
  }

  if (fromDate && toDate && fromDate > toDate) {
    const error = new Error("Ngày bắt đầu không được lớn hơn ngày kết thúc");
    error.statusCode = 400;
    throw error;
  }

  if (query.keyword && String(query.keyword).trim()) {
    const keyword = `%${String(query.keyword).trim()}%`;

    conditions.push(`
      (
        e.event_code LIKE ?
        OR p.full_name LIKE ?
        OR p.person_code LIKE ?
        OR c.camera_name LIKE ?
        OR c.camera_code LIKE ?
      )
    `);

    params.push(keyword, keyword, keyword, keyword, keyword);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

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
      LEFT JOIN persons p ON p.id = e.person_id
      LEFT JOIN cameras c ON c.id = e.camera_id
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
      LEFT JOIN persons p ON p.id = e.person_id
      LEFT JOIN cameras c ON c.id = e.camera_id
      WHERE e.id = ?
      LIMIT 1
    `,
    [eventId],
  );

  return rows[0] || null;
}

function resolveSnapshotPath(relativePath) {
  if (!relativePath) return null;

  const normalized = String(relativePath).replace(/\\/g, "/");

  if (
    !/^recognition\/\d{4}\/\d{2}\/\d{2}\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/i.test(
      normalized,
    )
  ) {
    return null;
  }

  const absolutePath = path.resolve(UPLOAD_ROOT, normalized);
  const relative = path.relative(RECOGNITION_ROOT, absolutePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return absolutePath;
}

function buildSessionFilters(query) {
  const conditions = [];
  const params = [];

  if (query.status) {
    const allowed = ["known", "unknown", "uncertain"];

    if (!allowed.includes(query.status)) {
      const error = new Error("Trạng thái nhận diện không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("s.recognition_status = ?");
    params.push(query.status);
  }

  if (query.session_status) {
    const allowed = ["open", "closed"];

    if (!allowed.includes(query.session_status)) {
      const error = new Error("Trạng thái phiên không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("s.session_status = ?");
    params.push(query.session_status);
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

  if (fromDate) {
    conditions.push("s.check_in_at >= ?");
    params.push(`${fromDate} 00:00:00`);
  }

  if (toDate) {
    conditions.push("s.check_in_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(`${toDate} 00:00:00`);
  }

  if (fromDate && toDate && fromDate > toDate) {
    const error = new Error("Ngày bắt đầu không được lớn hơn ngày kết thúc");
    error.statusCode = 400;
    throw error;
  }

  if (query.keyword && String(query.keyword).trim()) {
    const keyword = `%${String(query.keyword).trim()}%`;

    conditions.push(`
      (
        s.session_code LIKE ?
        OR p.full_name LIKE ?
        OR p.person_code LIKE ?
        OR c.camera_name LIKE ?
        OR c.camera_code LIKE ?
      )
    `);

    params.push(keyword, keyword, keyword, keyword, keyword);
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function listRecognitionSessions(query = {}) {
  const timeoutMinutes = Math.max(
    1,
    Number(process.env.RECOGNITION_SESSION_TIMEOUT_MINUTES || 10),
  );

  await pool.query(
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
        AND last_seen_at < DATE_SUB(
          NOW(),
          INTERVAL ? MINUTE
        )
    `,
    [timeoutMinutes, timeoutMinutes],
  );
  const { page, limit, offset } = buildPagination(query);
  const { whereSql, params } = buildSessionFilters(query);

  const [countRows] = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM recognition_sessions s
      LEFT JOIN persons p ON p.id = s.person_id
      LEFT JOIN cameras c ON c.id = s.camera_id
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
      LEFT JOIN persons p ON p.id = s.person_id
      LEFT JOIN cameras c ON c.id = s.camera_id
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
      LEFT JOIN persons p ON p.id = s.person_id
      LEFT JOIN cameras c ON c.id = s.camera_id
      WHERE s.id = ?
      LIMIT 1
    `,
    [sessionId],
  );

  return rows[0] || null;
}
async function bulkDeleteRecognitionRecords(ids, type) {
  if (!Array.isArray(ids) || ids.length === 0) {
    const error = new Error("Vui lòng chọn ít nhất một bản ghi");
    error.statusCode = 400;
    throw error;
  }

  const normalizedIds = [
    ...new Set(ids.map((id) => parsePositiveInteger(id, "id"))),
  ];

  if (normalizedIds.length > 500) {
    const error = new Error("Chỉ được xóa tối đa 500 bản ghi mỗi lần");
    error.statusCode = 400;
    throw error;
  }

  const table =
    type === "events"
      ? "recognition_events"
      : type === "sessions"
        ? "recognition_sessions"
        : null;

  if (!table) {
    const error = new Error("Loại dữ liệu không hợp lệ");
    error.statusCode = 400;
    throw error;
  }

  const connection = await pool.getConnection();
  let deletedRows = [];

  try {
    await connection.beginTransaction();

    const placeholders = normalizedIds.map(() => "?").join(",");

    const [rows] = await connection.query(
      `SELECT id, snapshot_path FROM ${table}
       WHERE id IN (${placeholders})`,
      normalizedIds,
    );

    deletedRows = rows;

    const [result] = await connection.query(
      `DELETE FROM ${table}
       WHERE id IN (${placeholders})`,
      normalizedIds,
    );

    await connection.commit();

    // Chỉ xóa ảnh snapshot sau khi database xóa thành công.
    for (const row of deletedRows) {
      const absolutePath = resolveSnapshotPath(row.snapshot_path);

      if (!absolutePath) continue;

      try {
        await fs.promises.unlink(absolutePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error("DELETE SNAPSHOT ERROR:", error);
        }
      }
    }

    return {
      requested: normalizedIds.length,
      deleted: result.affectedRows,
      ids: deletedRows.map((row) => row.id),
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function bulkDeleteRecognitionEvents(ids) {
  return bulkDeleteRecognitionRecords(ids, "events");
}

async function bulkDeleteRecognitionSessions(ids) {
  return bulkDeleteRecognitionRecords(ids, "sessions");
}
module.exports = {
  listRecognitionEvents,
  getRecognitionEventById,
  listRecognitionSessions,
  getRecognitionSessionById,
  resolveSnapshotPath,
  bulkDeleteRecognitionEvents,
  bulkDeleteRecognitionSessions,
};
