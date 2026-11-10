const { pool } = require("../config/database");

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
    const error = new Error(`${fieldName} không hợp lệ`);
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function getDateFilters(query = {}) {
  const from = validateDate(query.from, "from");
  const to = validateDate(query.to, "to");

  if (from && to && from > to) {
    const error = new Error("Ngày bắt đầu không được lớn hơn ngày kết thúc");
    error.statusCode = 400;
    throw error;
  }

  return { from, to };
}

/**
 * Thống kê tổng quan.
 * Mặc định lấy dữ liệu trong ngày hiện tại theo giờ MySQL.
 */
async function getRecognitionOverview(query = {}) {
  const { from, to } = getDateFilters(query);

  const [eventRows] = await pool.query(
    `
      SELECT
        COUNT(*) AS total_events,

        SUM(
          CASE WHEN recognition_status = 'known'
          THEN 1 ELSE 0 END
        ) AS known_events,

        SUM(
          CASE WHEN recognition_status = 'unknown'
          THEN 1 ELSE 0 END
        ) AS unknown_events,

        SUM(
          CASE WHEN recognition_status = 'uncertain'
          THEN 1 ELSE 0 END
        ) AS uncertain_events,

        COUNT(DISTINCT person_id) AS unique_people,

        SUM(
          CASE WHEN notification_sent = 1
          THEN 1 ELSE 0 END
        ) AS notifications_sent,

        SUM(
          CASE WHEN notification_sent = 0
          THEN 1 ELSE 0 END
        ) AS notifications_pending

      FROM recognition_events

      WHERE
        event_at >= COALESCE(?, CURDATE())
        AND event_at < DATE_ADD(
          COALESCE(?, CURDATE()),
          INTERVAL 1 DAY
        )
    `,
    [from, to],
  );

  const [sessionRows] = await pool.query(
    `
      SELECT
        COUNT(*) AS total_sessions,

        SUM(
          CASE WHEN session_status = 'open'
          THEN 1 ELSE 0 END
        ) AS open_sessions,

        SUM(
          CASE WHEN session_status = 'closed'
          THEN 1 ELSE 0 END
        ) AS closed_sessions

      FROM recognition_sessions

      WHERE
        check_in_at >= COALESCE(?, CURDATE())
        AND check_in_at < DATE_ADD(
          COALESCE(?, CURDATE()),
          INTERVAL 1 DAY
        )
    `,
    [from, to],
  );

  const events = eventRows[0] || {};
  const sessions = sessionRows[0] || {};

  return {
    period: {
      from: from || "today",
      to: to || "today",
    },

    events: {
      total: Number(events.total_events || 0),
      known: Number(events.known_events || 0),
      unknown: Number(events.unknown_events || 0),
      uncertain: Number(events.uncertain_events || 0),
      unique_people: Number(events.unique_people || 0),
    },

    notifications: {
      sent: Number(events.notifications_sent || 0),
      pending: Number(events.notifications_pending || 0),
    },

    sessions: {
      total: Number(sessions.total_sessions || 0),
      open: Number(sessions.open_sessions || 0),
      closed: Number(sessions.closed_sessions || 0),
    },
  };
}

/**
 * Thống kê lượt nhận diện theo ngày.
 * Mặc định lấy 7 ngày gần nhất.
 */
async function getRecognitionDailyStats(query = {}) {
  const { from, to } = getDateFilters(query);

  const [rows] = await pool.query(
    `
      SELECT
        DATE(event_at) AS date,

        COUNT(*) AS total,

        SUM(
          CASE WHEN recognition_status = 'known'
          THEN 1 ELSE 0 END
        ) AS known,

        SUM(
          CASE WHEN recognition_status = 'unknown'
          THEN 1 ELSE 0 END
        ) AS unknown,

        SUM(
          CASE WHEN recognition_status = 'uncertain'
          THEN 1 ELSE 0 END
        ) AS uncertain

      FROM recognition_events

      WHERE
        DATE(event_at) >= COALESCE(
          ?,
          DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        )
        AND DATE(event_at) <= COALESCE(?, CURDATE())

      GROUP BY DATE(event_at)
      ORDER BY date ASC
    `,
    [from, to],
  );

  return rows.map((row) => ({
    date:
      row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10),

    total: Number(row.total || 0),
    known: Number(row.known || 0),
    unknown: Number(row.unknown || 0),
    uncertain: Number(row.uncertain || 0),
  }));
}

/**
 * Thống kê theo camera.
 */
async function getRecognitionCameraStats(query = {}) {
  const { from, to } = getDateFilters(query);

  const [rows] = await pool.query(
    `
      SELECT
        e.camera_id,
        c.camera_code,
        c.camera_name,
        c.location,

        COUNT(*) AS total_events,

        SUM(
          CASE WHEN e.recognition_status = 'known'
          THEN 1 ELSE 0 END
        ) AS known_events,

        SUM(
          CASE WHEN e.recognition_status = 'unknown'
          THEN 1 ELSE 0 END
        ) AS unknown_events,

        SUM(
          CASE WHEN e.recognition_status = 'uncertain'
          THEN 1 ELSE 0 END
        ) AS uncertain_events

      FROM recognition_events e

      LEFT JOIN cameras c
        ON c.id = e.camera_id

      WHERE
        e.event_at >= COALESCE(?, CURDATE())
        AND e.event_at < DATE_ADD(
          COALESCE(?, CURDATE()),
          INTERVAL 1 DAY
        )

      GROUP BY
        e.camera_id,
        c.camera_code,
        c.camera_name,
        c.location

      ORDER BY total_events DESC
    `,
    [from, to],
  );

  return rows.map((row) => ({
    camera_id: row.camera_id,
    camera_code: row.camera_code,
    camera_name: row.camera_name || "Không xác định camera",
    location: row.location,
    total_events: Number(row.total_events || 0),
    known_events: Number(row.known_events || 0),
    unknown_events: Number(row.unknown_events || 0),
    uncertain_events: Number(row.uncertain_events || 0),
  }));
}

module.exports = {
  getRecognitionOverview,
  getRecognitionDailyStats,
  getRecognitionCameraStats,
};
