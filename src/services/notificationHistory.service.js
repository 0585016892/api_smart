// src/services/notificationHistory.service.js

const { pool } = require("../config/database");

function buildFilters(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.status && ["success", "failed"].includes(filters.status)) {
    conditions.push("n.status = ?");
    params.push(filters.status);
  }

  if (
    filters.notification_type &&
    ["known", "unknown", "system"].includes(filters.notification_type)
  ) {
    conditions.push("n.notification_type = ?");
    params.push(filters.notification_type);
  }

  if (filters.send_type && ["photo", "message"].includes(filters.send_type)) {
    conditions.push("n.send_type = ?");
    params.push(filters.send_type);
  }

  if (filters.event_id) {
    conditions.push("n.event_id = ?");
    params.push(Number(filters.event_id));
  }

  if (filters.from) {
    conditions.push("n.created_at >= ?");
    params.push(`${filters.from} 00:00:00`);
  }

  if (filters.to) {
    conditions.push("n.created_at <= ?");
    params.push(`${filters.to} 23:59:59`);
  }

  if (filters.keyword) {
    const keyword = `%${String(filters.keyword).trim()}%`;

    conditions.push(`
      (
        n.recipient_chat_id LIKE ?
        OR n.recipient_name LIKE ?
        OR n.title LIKE ?
        OR n.message LIKE ?
        OR n.error_message LIKE ?
        OR e.event_code LIKE ?
      )
    `);

    params.push(keyword, keyword, keyword, keyword, keyword, keyword);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function getNotificationHistory(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20));

  const offset = (page - 1) * limit;

  const { where, params } = buildFilters(filters);

  const [countRows] = await pool.query(
    `
      SELECT COUNT(*) AS total
      FROM notification_logs n
      LEFT JOIN recognition_events e ON e.id = n.event_id
      ${where}
    `,
    params,
  );

  const total = Number(countRows[0]?.total || 0);

  const [rows] = await pool.query(
    `
      SELECT
        n.id,
        n.event_id,
        n.notification_type,
        n.channel,
        n.send_type,
        n.recipient_chat_id,
        n.recipient_name,
        n.title,
        n.message,
        n.status,
        n.telegram_message_id,
        n.error_message,
        n.sent_at,
        n.created_at,
        e.event_code,
        e.recognition_status,
        e.confidence,
        e.snapshot_path,
        e.event_at
      FROM notification_logs n
      LEFT JOIN recognition_events e ON e.id = n.event_id
      ${where}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

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

async function getNotificationDetail(id) {
  const [rows] = await pool.query(
    `
      SELECT
        n.*,
        e.event_code,
        e.recognition_status,
        e.confidence,
        e.snapshot_path,
        e.face_image_path,
        e.event_at,
        e.camera_id,
        e.person_id
      FROM notification_logs n
      LEFT JOIN recognition_events e ON e.id = n.event_id
      WHERE n.id = ?
      LIMIT 1
    `,
    [id],
  );

  return rows[0] || null;
}

async function getNotificationStats(filters = {}) {
  const { where, params } = buildFilters(filters);

  const [rows] = await pool.query(
    `
      SELECT
        COUNT(*) AS total,
        SUM(n.status = 'success') AS success_count,
        SUM(n.status = 'failed') AS failed_count,
        SUM(n.notification_type = 'known') AS known_count,
        SUM(n.notification_type = 'unknown') AS unknown_count,
        SUM(n.send_type = 'photo') AS photo_count,
        SUM(n.send_type = 'message') AS message_count
      FROM notification_logs n
      LEFT JOIN recognition_events e ON e.id = n.event_id
      ${where}
    `,
    params,
  );

  const stats = rows[0] || {};

  return {
    total: Number(stats.total || 0),
    success: Number(stats.success_count || 0),
    failed: Number(stats.failed_count || 0),
    known: Number(stats.known_count || 0),
    unknown: Number(stats.unknown_count || 0),
    photo: Number(stats.photo_count || 0),
    message: Number(stats.message_count || 0),
  };
}

async function deleteNotificationHistory(id) {
  const [result] = await pool.query(
    `DELETE FROM notification_logs WHERE id = ?`,
    [id],
  );

  return result.affectedRows > 0;
}

async function deleteOldNotificationHistory(days = 180) {
  const retentionDays = Math.min(3650, Math.max(1, Number(days) || 180));

  const [result] = await pool.query(
    `
      DELETE FROM notification_logs
      WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
    `,
    [retentionDays],
  );

  return {
    deleted_count: result.affectedRows,
    retention_days: retentionDays,
  };
}

module.exports = {
  getNotificationHistory,
  getNotificationDetail,
  getNotificationStats,
  deleteNotificationHistory,
  deleteOldNotificationHistory,
};
