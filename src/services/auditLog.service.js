const { pool } = require("../config/database");

async function writeAuditLog(data) {
  const {
    user_id = null,
    username = null,
    action,
    resource,
    resource_id = null,
    description = null,
    method = null,
    endpoint = null,
    ip_address = null,
    user_agent = null,
    status_code = null,
    result = "success",
    metadata = null,
  } = data;

  await pool.execute(
    `
      INSERT INTO audit_logs (
        user_id,
        username,
        action,
        resource,
        resource_id,
        description,
        method,
        endpoint,
        ip_address,
        user_agent,
        status_code,
        result,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      user_id,
      username,
      action,
      resource,
      resource_id === null ? null : String(resource_id),
      description,
      method,
      endpoint,
      ip_address,
      user_agent,
      status_code,
      result,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

function buildFilters(query = {}) {
  const conditions = [];
  const params = [];

  if (query.keyword) {
    const keyword = `%${String(query.keyword).trim()}%`;

    conditions.push(`(
      username LIKE ?
      OR action LIKE ?
      OR resource LIKE ?
      OR description LIKE ?
      OR ip_address LIKE ?
    )`);

    params.push(keyword, keyword, keyword, keyword, keyword);
  }

  if (query.user_id) {
    const id = Number(query.user_id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      const error = new Error("ID tài khoản không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("user_id = ?");
    params.push(id);
  }

  if (query.action) {
    conditions.push("action = ?");
    params.push(String(query.action).slice(0, 100));
  }

  if (query.resource) {
    conditions.push("resource = ?");
    params.push(String(query.resource).slice(0, 100));
  }

  if (query.result) {
    if (!["success", "failure"].includes(query.result)) {
      const error = new Error("Kết quả nhật ký không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("result = ?");
    params.push(query.result);
  }

  if (query.from) {
    if (Number.isNaN(Date.parse(query.from))) {
      const error = new Error("Ngày bắt đầu không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("created_at >= ?");
    params.push(query.from);
  }

  if (query.to) {
    if (Number.isNaN(Date.parse(query.to))) {
      const error = new Error("Ngày kết thúc không hợp lệ");
      error.statusCode = 400;
      throw error;
    }

    conditions.push("created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(query.to);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function getAuditLogs(query = {}) {
  const pageValue = Number(query.page);
  const limitValue = Number(query.limit);

  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;

  const limit =
    Number.isSafeInteger(limitValue) && limitValue > 0
      ? Math.min(limitValue, 100)
      : 20;

  const offset = (page - 1) * limit;
  const { where, params } = buildFilters(query);

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM audit_logs ${where}`,
    params,
  );

  const [rows] = await pool.execute(
    `
      SELECT
        id,
        user_id,
        username,
        action,
        resource,
        resource_id,
        description,
        method,
        endpoint,
        ip_address,
        user_agent,
        status_code,
        result,
        metadata,
        created_at
      FROM audit_logs
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    [...params, limit, offset],
  );

  return {
    items: rows.map((row) => ({
      ...row,
      metadata:
        typeof row.metadata === "string"
          ? safeParseJson(row.metadata)
          : row.metadata,
    })),
    pagination: {
      page,
      limit,
      total: Number(countRows[0]?.total || 0),
      totalPages: Math.ceil(Number(countRows[0]?.total || 0) / limit),
    },
  };
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function getAuditSummary() {
  const [rows] = await pool.execute(`
    SELECT
      COUNT(*) AS total,
      SUM(result = 'success') AS success_count,
      SUM(result = 'failure') AS failure_count,
      COUNT(DISTINCT user_id) AS active_users,
      SUM(created_at >= NOW() - INTERVAL 24 HOUR) AS last_24_hours
    FROM audit_logs
  `);

  const [actions] = await pool.execute(`
    SELECT action, COUNT(*) AS total
    FROM audit_logs
    WHERE created_at >= NOW() - INTERVAL 7 DAY
    GROUP BY action
    ORDER BY total DESC
    LIMIT 10
  `);

  return {
    ...rows[0],
    total: Number(rows[0].total || 0),
    success_count: Number(rows[0].success_count || 0),
    failure_count: Number(rows[0].failure_count || 0),
    active_users: Number(rows[0].active_users || 0),
    last_24_hours: Number(rows[0].last_24_hours || 0),
    top_actions: actions,
  };
}

async function deleteOldAuditLogs(days = 180) {
  const retentionDays = Number(days);

  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 30 ||
    retentionDays > 3650
  ) {
    const error = new Error("Thời gian lưu nhật ký phải từ 30 đến 3650 ngày");
    error.statusCode = 400;
    throw error;
  }

  const [result] = await pool.execute(
    `
      DELETE FROM audit_logs
      WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
    `,
    [retentionDays],
  );

  return {
    deleted: result.affectedRows,
    retention_days: retentionDays,
  };
}

module.exports = {
  writeAuditLog,
  getAuditLogs,
  getAuditSummary,
  deleteOldAuditLogs,
};
