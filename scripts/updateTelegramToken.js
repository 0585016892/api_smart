require("dotenv").config();

const readline = require("readline");
const { pool } = require("../src/config/database");
const { encryptSecret } = require("../src/utils/secretEncryption");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function main() {
  try {
    const token = await new Promise((resolve) => {
      rl.question("Nhập Telegram Bot Token: ", resolve);
    });

    if (!token.trim()) {
      throw new Error("Bot Token không được để trống");
    }

    const encryptedToken = encryptSecret(token.trim());

    await pool.query(
      `INSERT INTO telegram_settings
        (id, bot_token_encrypted, is_enabled, notify_known, notify_unknown)
       VALUES (1, ?, 1, 1, 1)
       ON DUPLICATE KEY UPDATE
         bot_token_encrypted = VALUES(bot_token_encrypted)`,
      [encryptedToken],
    );

    console.log("Đã lưu Bot Token được mã hóa thành công!");
  } catch (error) {
    console.error("LỖI:", error.message);
  } finally {
    rl.close();
    await pool.end();
  }
}

main();
