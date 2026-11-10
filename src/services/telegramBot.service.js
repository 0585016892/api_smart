const { pool } = require("../config/database");
const { decryptSecret } = require("../utils/secretEncryption");
const telegramLinkService = require("./telegramLink.service");

let pollingStarted = false;
let shouldStop = false;
let pollingOffset = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getBotToken() {
  const [rows] = await pool.query(`
    SELECT bot_token_encrypted
    FROM telegram_settings
    ORDER BY id DESC
    LIMIT 1
  `);

  if (!rows.length || !rows[0].bot_token_encrypted) {
    return null;
  }

  return decryptSecret(rows[0].bot_token_encrypted);
}

async function telegramApi(token, method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === "getUpdates" ? 35000 : 15000),
    },
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram API HTTP ${response.status}`,
    );
  }

  return result.result;
}

async function sendBotMessage(token, chatId, message) {
  return telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: true,
  });
}

async function handleStartCommand(token, message) {
  const chat = message.chat;
  const from = message.from;
  const text = String(message.text || "").trim();

  if (!chat || !from) return;

  // Chỉ nhận liên kết trong chat riêng với Bot.
  if (chat.type !== "private") {
    return;
  }

  const match = text.match(/^\/start(?:@\w+)?(?:\s+([a-f0-9]{48}))?$/i);

  if (!match) {
    await sendBotMessage(
      token,
      chat.id,
      "👋 Chào bạn!\n\nĐể liên kết tài khoản Smart Face Security, hãy tạo mã liên kết trong phần Hồ sơ cá nhân trên hệ thống rồi gửi:\n\n/start MÃ_LIÊN_KẾT",
    );
    return;
  }

  const linkCode = match[1];

  if (!linkCode) {
    await sendBotMessage(
      token,
      chat.id,
      "Bạn chưa gửi mã liên kết.\n\nHãy tạo mã trong Smart Face Security rồi gửi /start kèm mã đó nhé.",
    );
    return;
  }

  try {
    await telegramLinkService.completeTelegramLink({
      token: linkCode,
      telegramId: from.id,
      chatId: chat.id,
      username: from.username,
      firstName: from.first_name,
    });

    await sendBotMessage(
      token,
      chat.id,
      "✅ LIÊN KẾT THÀNH CÔNG!\n\nTài khoản Telegram của bạn đã được kết nối với Smart Face Security.\n\nBạn sẽ nhận thông báo nhận diện theo cài đặt cá nhân.",
    );

    console.log(`[TELEGRAM BOT] Linked Telegram account ${from.id}`);
  } catch (error) {
    await sendBotMessage(
      token,
      chat.id,
      `❌ Không thể liên kết tài khoản.\n\n${error.message}\n\nVui lòng quay lại Smart Face Security để tạo mã mới nếu mã đã hết hạn.`,
    );
  }
}

async function handleUpdate(token, update) {
  if (update.message) {
    await handleStartCommand(token, update.message);
  }
}

async function pollingLoop() {
  while (!shouldStop) {
    try {
      const token = await getBotToken();

      if (!token) {
        await sleep(10000);
        continue;
      }

      const updates = await telegramApi(token, "getUpdates", {
        offset: pollingOffset,
        timeout: 25,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        pollingOffset = update.update_id + 1;

        try {
          await handleUpdate(token, update);
        } catch (error) {
          console.error("[TELEGRAM BOT UPDATE ERROR]:", error.message);
        }
      }
    } catch (error) {
      console.error("[TELEGRAM BOT POLLING ERROR]:", error.message);

      await sleep(5000);
    }
  }

  pollingStarted = false;
}

function startTelegramBot() {
  if (pollingStarted) return;

  pollingStarted = true;
  shouldStop = false;

  console.log("[TELEGRAM BOT] Long polling started");

  pollingLoop().catch((error) => {
    pollingStarted = false;
    console.error("[TELEGRAM BOT FATAL ERROR]:", error);
  });
}

function stopTelegramBot() {
  shouldStop = true;
}

module.exports = {
  startTelegramBot,
  stopTelegramBot,
};
