const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey() {
  const value = process.env.TELEGRAM_ENCRYPTION_KEY;

  if (!value) {
    throw new Error("Thiếu TELEGRAM_ENCRYPTION_KEY trong file .env");
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new Error("TELEGRAM_ENCRYPTION_KEY phải là khóa Base64 của 32 byte");
  }

  return key;
}

function encryptSecret(plainText) {
  if (!plainText) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

function decryptSecret(encryptedValue) {
  if (!encryptedValue) return null;

  const parts = encryptedValue.split(".");

  if (parts.length !== 3) {
    throw new Error("Dữ liệu Bot Token đã mã hóa không hợp lệ");
  }

  const [ivBase64, tagBase64, dataBase64] = parts;

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(ivBase64, "base64"),
  );

  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataBase64, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

module.exports = {
  encryptSecret,
  decryptSecret,
};
