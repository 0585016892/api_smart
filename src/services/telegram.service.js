// src/services/telegram.service.js

const { pool } = require("../config/database");
const { encryptSecret, decryptSecret } = require("../utils/secretEncryption");

// ======================================================
// TELEGRAM SETTINGS
// ======================================================

async function getSettingsRow() {
  const [rows] = await pool.query(`
    SELECT *
    FROM telegram_settings
    ORDER BY id DESC
    LIMIT 1
  `);

  return rows[0] || null;
}

async function ensureSettingsRow() {
  let settings = await getSettingsRow();

  if (!settings) {
    const [result] = await pool.query(`
      INSERT INTO telegram_settings
        (bot_token_encrypted, chat_id, is_enabled, notify_known, notify_unknown)
      VALUES (NULL, NULL, 0, 1, 1)
    `);

    settings = {
      id: result.insertId,
      bot_token_encrypted: null,
      chat_id: null,
      is_enabled: 0,
      notify_known: 1,
      notify_unknown: 1,
    };
  }

  return settings;
}

function toPublicSettings(settings) {
  return {
    configured: Boolean(settings.bot_token_encrypted && settings.chat_id),
    chat_id: settings.chat_id || "",
    is_enabled: Boolean(settings.is_enabled),
    notify_known: Boolean(settings.notify_known),
    notify_unknown: Boolean(settings.notify_unknown),
    token_masked: settings.bot_token_encrypted ? "••••••••••••" : "",
  };
}

async function getTelegramSettings() {
  const settings = await getSettingsRow();

  if (!settings) {
    return {
      configured: false,
      chat_id: "",
      is_enabled: false,
      notify_known: true,
      notify_unknown: true,
      token_masked: "",
    };
  }

  return toPublicSettings(settings);
}

async function updateTelegramSettings(data = {}) {
  const current = await ensureSettingsRow();

  const chatId =
    data.chat_id !== undefined
      ? String(data.chat_id || "").trim()
      : current.chat_id;

  const botToken =
    data.bot_token !== undefined ? String(data.bot_token || "").trim() : "";

  if (data.chat_id !== undefined && !chatId) {
    const error = new Error("Vui lòng nhập Chat ID");
    error.statusCode = 400;
    throw error;
  }

  let encryptedToken = current.bot_token_encrypted;

  if (botToken) {
    encryptedToken = encryptSecret(botToken);
  }

  const isEnabled =
    data.is_enabled !== undefined
      ? Boolean(data.is_enabled)
      : Boolean(current.is_enabled);

  const notifyKnown =
    data.notify_known !== undefined
      ? Boolean(data.notify_known)
      : Boolean(current.notify_known);

  const notifyUnknown =
    data.notify_unknown !== undefined
      ? Boolean(data.notify_unknown)
      : Boolean(current.notify_unknown);

  if (isEnabled && (!encryptedToken || !chatId)) {
    const error = new Error(
      "Cần cấu hình Bot Token và Chat ID trước khi bật thông báo",
    );
    error.statusCode = 400;
    throw error;
  }

  await pool.query(
    `
      UPDATE telegram_settings
      SET
        bot_token_encrypted = ?,
        chat_id = ?,
        is_enabled = ?,
        notify_known = ?,
        notify_unknown = ?
      WHERE id = ?
    `,
    [
      encryptedToken,
      chatId || null,
      isEnabled ? 1 : 0,
      notifyKnown ? 1 : 0,
      notifyUnknown ? 1 : 0,
      current.id,
    ],
  );

  return getTelegramSettings();
}

// ======================================================
// TELEGRAM API
// ======================================================

function getTelegramUrl(token, action) {
  return `https://api.telegram.org/bot${token}/${action}`;
}

async function parseTelegramResponse(response, action) {
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    console.error("[TELEGRAM API ERROR]", {
      action,
      httpStatus: response.status,
      description: result.description,
      errorCode: result.error_code,
    });

    const error = new Error(
      result.description || `Telegram API lỗi HTTP ${response.status}`,
    );

    error.statusCode = 502;
    throw error;
  }

  return result.result;
}

async function telegramRequest(method, body) {
  const response = await fetch(getTelegramUrl(method.token, method.action), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  return parseTelegramResponse(response, method.action);
}

async function telegramPhotoRequest(token, data) {
  const { chatId, imageBuffer, filename = "recognition.jpg", caption } = data;

  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    throw new Error("Ảnh gửi Telegram không hợp lệ");
  }

  const extension = filename.split(".").pop().toLowerCase();

  const mimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };

  const mimeType = mimeTypes[extension] || "image/jpeg";

  const form = new FormData();

  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([imageBuffer], { type: mimeType }), filename);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");

  const response = await fetch(getTelegramUrl(token, "sendPhoto"), {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  return parseTelegramResponse(response, "sendPhoto");
}

// ======================================================
// TELEGRAM CREDENTIALS
// ======================================================

async function getTelegramCredentials() {
  const settings = await getSettingsRow();

  if (!settings || !settings.bot_token_encrypted || !settings.chat_id) {
    throw new Error("Chưa cấu hình Telegram Bot Token hoặc Chat ID");
  }

  return {
    token: decryptSecret(settings.bot_token_encrypted),
    chatId: settings.chat_id,
    settings,
  };
}

// ======================================================
// SEND MESSAGE
// ======================================================

async function sendTelegramMessage(message) {
  const { token, chatId } = await getTelegramCredentials();

  return telegramRequest(
    { token, action: "sendMessage" },
    {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  );
}

// ======================================================
// TEST CONNECTION
// ======================================================

async function testTelegramConnection() {
  const { token, chatId } = await getTelegramCredentials();

  console.log("[TELEGRAM] Checking bot token...");

  const botResponse = await telegramRequest({ token, action: "getMe" }, {});

  console.log("[TELEGRAM] Bot verified:", botResponse.username);

  await telegramRequest(
    { token, action: "sendMessage" },
    {
      chat_id: chatId,
      text:
        "✅ <b>Smart Face Security</b>\n" +
        "Kết nối Telegram thành công!\n" +
        `Bot: @${botResponse.username || "unknown"}`,
      parse_mode: "HTML",
    },
  );

  console.log("[TELEGRAM] Test message sent");

  return {
    bot_name: botResponse.first_name,
    username: botResponse.username,
    message: "Kết nối Telegram thành công",
  };
}

// ======================================================
// NOTIFICATION HISTORY
// ======================================================

async function writeNotificationLog(data) {
  try {
    await pool.query(
      `
        INSERT INTO notification_logs (
          event_id,
          notification_type,
          channel,
          send_type,
          recipient_chat_id,
          recipient_name,
          title,
          message,
          status,
          telegram_message_id,
          error_message,
          sent_at
        )
        VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        data.event_id || null,
        data.notification_type || "system",
        data.send_type || "message",
        String(data.recipient_chat_id),
        data.recipient_name || null,
        data.title || null,
        data.message || null,
        data.status,
        data.telegram_message_id || null,
        data.error_message || null,
        data.status === "success" ? new Date() : null,
      ],
    );
  } catch (error) {
    // Lỗi lưu lịch sử không được làm ảnh hưởng luồng nhận diện.
    console.error("[NOTIFICATION HISTORY ERROR]:", error.message);
  }
}

// ======================================================
// RECOGNITION NOTIFICATION
// ======================================================

async function sendRecognitionNotification(data = {}) {
  const settings = await getSettingsRow();

  if (!settings || !settings.is_enabled) {
    return {
      sent: false,
      reason: "telegram_disabled",
      sent_count: 0,
      failed_count: 0,
      total_recipients: 0,
    };
  }

  const status = data.recognition_status;

  if (!["known", "unknown"].includes(status)) {
    return {
      sent: false,
      reason: "unsupported_status",
      sent_count: 0,
      failed_count: 0,
      total_recipients: 0,
    };
  }

  if (status === "known" && !settings.notify_known) {
    return {
      sent: false,
      reason: "known_notification_disabled",
      sent_count: 0,
      failed_count: 0,
      total_recipients: 0,
    };
  }

  if (status === "unknown" && !settings.notify_unknown) {
    return {
      sent: false,
      reason: "unknown_notification_disabled",
      sent_count: 0,
      failed_count: 0,
      total_recipients: 0,
    };
  }

  if (!settings.bot_token_encrypted) {
    return {
      sent: false,
      reason: "telegram_not_configured",
      sent_count: 0,
      failed_count: 0,
      total_recipients: 0,
    };
  }

  const token = decryptSecret(settings.bot_token_encrypted);

  const preferenceColumn =
    status === "known" ? "notify_known" : "notify_unknown";

  const [links] = await pool.query(
    `
      SELECT chat_id
      FROM telegram_user_links
      WHERE is_active = 1
        AND ${preferenceColumn} = 1
    `,
  );

  const recipients = new Set(links.map((item) => String(item.chat_id)));

  // Giữ khả năng gửi đến Chat ID quản trị cũ.
  if (settings.chat_id) {
    recipients.add(String(settings.chat_id));
  }

  if (!recipients.size) {
    return {
      sent: false,
      reason: "no_active_recipients",
      sent_count: 0,
      failed_count: 0,
      total_recipients: 0,
    };
  }

  const personName =
    status === "known"
      ? escapeHtml(data.person_name || "Chưa có tên")
      : "Người chưa xác định";

  const cameraName = escapeHtml(data.camera_name || "Camera không xác định");

  const eventCode = escapeHtml(data.event_code || "");

  const confidence =
    data.confidence === null ||
    data.confidence === undefined ||
    data.confidence === ""
      ? null
      : Number(data.confidence);

  const confidenceText =
    confidence !== null && Number.isFinite(confidence)
      ? `${(confidence * 100).toFixed(2)}%`
      : "Không xác định";

  const message = [
    status === "known"
      ? "🟢 <b>PHÁT HIỆN NGƯỜI ĐÃ ĐĂNG KÝ</b>"
      : "🔴 <b>PHÁT HIỆN NGƯỜI LẠ</b>",
    "",
    `👤 Đối tượng: <b>${personName}</b>`,
    `📷 Camera: ${cameraName}`,
    `🎯 Độ tin cậy: ${confidenceText}`,
    `🕒 Thời gian: ${new Date().toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
    })}`,
    eventCode ? `🧾 Mã sự kiện: <code>${eventCode}</code>` : "",
    "",
    "Smart Face Security",
  ]
    .filter(Boolean)
    .join("\n");

  const sendType =
    Buffer.isBuffer(data.imageBuffer) && data.imageBuffer.length
      ? "photo"
      : "message";

  const title =
    status === "known" ? "Phát hiện người đã đăng ký" : "Phát hiện người lạ";

  const sendTasks = Array.from(recipients).map(async (chatId) => {
    try {
      let telegramResult;

      if (sendType === "photo") {
        telegramResult = await telegramPhotoRequest(token, {
          chatId,
          imageBuffer: data.imageBuffer,
          filename: data.filename || "recognition.jpg",
          caption: message,
        });
      } else {
        telegramResult = await telegramRequest(
          { token, action: "sendMessage" },
          {
            chat_id: chatId,
            text: message,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          },
        );
      }

      await writeNotificationLog({
        event_id: data.event_id,
        notification_type: status,
        send_type: sendType,
        recipient_chat_id: chatId,
        title,
        message,
        status: "success",
        telegram_message_id: telegramResult?.message_id || null,
      });

      return {
        chat_id: chatId,
        success: true,
      };
    } catch (error) {
      await writeNotificationLog({
        event_id: data.event_id,
        notification_type: status,
        send_type: sendType,
        recipient_chat_id: chatId,
        title,
        message,
        status: "failed",
        error_message: error.message,
      });

      console.error("[TELEGRAM] Send failed:", {
        chat_id: chatId,
        error: error.message,
      });

      return {
        chat_id: chatId,
        success: false,
        error: error.message,
      };
    }
  });

  const results = await Promise.all(sendTasks);

  const sentCount = results.filter((item) => item.success).length;
  const failedCount = results.length - sentCount;

  return {
    sent: sentCount > 0,
    type: sendType,
    sent_count: sentCount,
    failed_count: failedCount,
    total_recipients: recipients.size,
  };
}

// ======================================================
// HTML ESCAPE
// ======================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  getTelegramSettings,
  updateTelegramSettings,
  testTelegramConnection,
  sendTelegramMessage,
  sendRecognitionNotification,
};
