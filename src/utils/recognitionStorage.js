const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FileType = require("file-type");

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || "uploads");
const RECOGNITION_ROOT = path.join(UPLOAD_ROOT, "recognition");

const ALLOWED_EXTENSIONS = {
  jpg: "jpg",
  png: "png",
  webp: "webp",
};

async function saveRecognitionSnapshot(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error("Ảnh snapshot không hợp lệ");
    error.statusCode = 400;
    throw error;
  }

  const detected = await FileType.fromBuffer(buffer);

  if (!detected || !ALLOWED_EXTENSIONS[detected.ext]) {
    const error = new Error("Snapshot chỉ chấp nhận ảnh JPG, PNG hoặc WEBP");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date();

  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  const relativeDirectory = path.join("recognition", year, month, day);
  const absoluteDirectory = path.join(UPLOAD_ROOT, relativeDirectory);

  await fs.promises.mkdir(absoluteDirectory, {
    recursive: true,
  });

  const filename = `${Date.now()}_${crypto.randomUUID()}.${ALLOWED_EXTENSIONS[detected.ext]}`;
  const absolutePath = path.join(absoluteDirectory, filename);

  await fs.promises.writeFile(absolutePath, buffer, {
    flag: "wx",
  });

  return {
    filename,
    absolutePath,
    relativePath: path.join(relativeDirectory, filename).replace(/\\/g, "/"),
  };
}

async function deleteRecognitionSnapshot(relativePath) {
  if (!relativePath) return;

  const normalized = relativePath.replace(/\\/g, "/");

  if (
    !/^recognition\/\d{4}\/\d{2}\/\d{2}\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/i.test(
      normalized,
    )
  ) {
    return;
  }

  const absolutePath = path.resolve(UPLOAD_ROOT, normalized);
  const relative = path.relative(RECOGNITION_ROOT, absolutePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }

  try {
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("DELETE SNAPSHOT ERROR:", error.message);
    }
  }
}

module.exports = {
  saveRecognitionSnapshot,
  deleteRecognitionSnapshot,
};
