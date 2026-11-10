const { pool } = require("../config/database");

const ALLOWED_STATUSES = ["open", "closed"];

function createError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parsePositiveInt(value, fallback, max = 1000000) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number <= 0) {
    return fallback;
  }

  return Math.min(number, max);
}

function buildFilters(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.status) {
    if (!ALLOWED_STATUSES.includes(filters.status)) {
      throw createError("Trạng thái phiên không hợp lệ");
    }

    conditions.push("rs.session_status = ?");
    params.push(filters.status);
  }

  if (filters.person_id) {
    const personId = parsePositiveInt(filters.person_id, null);

    if (!personId) throw createError("ID người không hợp lệ");

    conditions.push("rs.person_id = ?");
    params.push(personId);
  }

  if (filters.camera_id) {
    const cameraId = parsePositiveInt(filters.camera_id, null);

    if (!cameraId) throw createError("ID camera không hợp lệ");

    conditions.push("rs.camera_id = ?");
    params.push(cameraId);
  }

  if (filters.from) {
    if (Number.isNaN(Date.parse(filters.from))) {
      throw createError("Ngày bắt đầu không hợp lệ");
    }

    conditions.push("rs.check_in_at >= ?");
    params.push(filters.from);
  }

  if (filters.to) {
    if (Number.isNaN(Date.parse(filters.to))) {
      throw createError("Ngày kết thúc không hợp lệ");
    }

    conditions.push("rs.check_in_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(filters.to);
  }

  if (filters.keyword) {
    const keyword = `%${String(filters.keyword).trim()}%`;

    conditions.push(`(
      rs.session_code LIKE ?
      OR p.full_name LIKE ?
      OR p.person_code LIKE ?
      OR c.camera_name LIKE ?
      OR c.camera_code LIKE ?
    )`);

    params.push(keyword, keyword, keyword, keyword, keyword);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * Danh sách phiên nhận diện.
 */
async function getRecognitionSessions(filters = {}) {
  const page = parsePositiveInt(filters.page, 1);
  const limit = parsePositiveInt(filters.limit, 20, 100);
  const offset = (page - 1) * limit;

  const { where, params } = buildFilters(filters);

  const [countRows] = await pool.execute(
    `
      SELECT COUNT(*) AS total
      FROM recognition_sessions rs
      LEFT JOIN persons p ON p.id = rs.person_id
      LEFT JOIN cameras c ON c.id = rs.camera_id
      ${where}
    `,
    params,
  );

  const [rows] = await pool.execute(
    `
      SELECT
        rs.id,
        rs.session_code,
        rs.person_id,
        p.person_code,
        p.full_name AS person_name,
        p.avatar_path,
        rs.camera_id,
        c.camera_code,
        c.camera_name,
        c.location AS camera_location,
        rs.recognition_status,
        rs.check_in_at,
        rs.last_seen_at,
        rs.check_out_at,
        rs.snapshot_path,
        rs.event_count,
        rs.session_status,
        rs.created_at,
        rs.updated_at
      FROM recognition_sessions rs
      LEFT JOIN persons p ON p.id = rs.person_id
      LEFT JOIN cameras c ON c.id = rs.camera_id
      ${where}
      ORDER BY rs.check_in_at DESC, rs.id DESC
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
 * Chi tiết phiên và các sự kiện thuộc phiên.
 */
async function getRecognitionSessionDetail(id) {
  const sessionId = parsePositiveInt(id, null);

  if (!sessionId) throw createError("ID phiên không hợp lệ");

  const [sessions] = await pool.execute(
    `
      SELECT
        rs.*,
        p.person_code,
        p.full_name AS person_name,
        p.phone AS person_phone,
        p.avatar_path,
        c.camera_code,
        c.camera_name,
        c.location AS camera_location
      FROM recognition_sessions rs
      LEFT JOIN persons p ON p.id = rs.person_id
      LEFT JOIN cameras c ON c.id = rs.camera_id
      WHERE rs.id = ?
      LIMIT 1
    `,
    [sessionId],
  );

  if (!sessions.length) {
    throw createError("Không tìm thấy phiên nhận diện", 404);
  }

  const session = sessions[0];

  const [events] = await pool.execute(
    `
      SELECT
        id,
        event_code,
        recognition_status,
        direction,
        confidence,
        snapshot_path,
        face_count,
        notification_sent,
        notification_sent_at,
        event_at
      FROM recognition_events
      WHERE
        person_id = ?
        AND camera_id <=> ?
        AND event_at >= ?
        AND event_at <= ?
      ORDER BY event_at ASC, id ASC
    `,
    [
      session.person_id,
      session.camera_id,
      session.check_in_at,
      session.last_seen_at,
    ],
  );

  return {
    ...session,
    events,
  };
}

/**
 * Đóng phiên đang mở theo yêu cầu quản trị.
 */
async function closeRecognitionSession(id) {
  const sessionId = parsePositiveInt(id, null);

  if (!sessionId) throw createError("ID phiên không hợp lệ");

  const [result] = await pool.execute(
    `
      UPDATE recognition_sessions
      SET
        session_status = 'closed',
        check_out_at = COALESCE(last_seen_at, NOW())
      WHERE id = ?
        AND session_status = 'open'
    `,
    [sessionId],
  );

  if (!result.affectedRows) {
    const [rows] = await pool.execute(
      `SELECT id, session_status
       FROM recognition_sessions
       WHERE id = ?
       LIMIT 1`,
      [sessionId],
    );

    if (!rows.length) {
      throw createError("Không tìm thấy phiên nhận diện", 404);
    }

    throw createError("Phiên nhận diện đã được đóng trước đó");
  }

  return getRecognitionSessionDetail(sessionId);
}

module.exports = {
  getRecognitionSessions,
  getRecognitionSessionDetail,
  closeRecognitionSession,
};
