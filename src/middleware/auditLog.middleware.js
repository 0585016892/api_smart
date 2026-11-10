const auditLogService = require("../services/auditLog.service");

const ACTION_BY_METHOD = {
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

function getResource(req) {
  const segments = String(req.baseUrl || "")
    .split("/")
    .filter(Boolean);

  return segments[segments.length - 1] || "system";
}

function auditLog(req, res, next) {
  const action = ACTION_BY_METHOD[req.method];

  if (!action) {
    return next();
  }

  const user = req.user || {};
  const resource = getResource(req);
  const resourceId = req.params?.id || null;

  res.on("finish", () => {
    const success = res.statusCode >= 200 && res.statusCode < 400;

    auditLogService
      .writeAuditLog({
        user_id: user.id || null,
        username: user.username || null,
        action,
        resource,
        resource_id: resourceId,
        description: `${action} ${resource}`,
        method: req.method,
        endpoint: `${req.baseUrl || ""}${req.path || ""}`,
        ip_address: req.ip || null,
        user_agent: req.get("user-agent") || null,
        status_code: res.statusCode,
        result: success ? "success" : "failure",
        metadata: {
          params: {
            ...req.params,
          },
        },
      })
      .catch((error) => {
        console.error("[AUDIT LOG ERROR]:", error.message);
      });
  });

  next();
}

module.exports = auditLog;
