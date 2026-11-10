const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FileType = require("file-type");

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || "uploads");

const PERSON_DIR = path.join(UPLOAD_ROOT, "persons");

const ensureDirectory = async () => {
  await fs.promises.mkdir(PERSON_DIR, {
    recursive: true,
  });
};

const savePersonAvatar = async (file) => {
  if (!file || !file.buffer) {
    return null;
  }

  const detected = await FileType.fromBuffer(file.buffer);

  const allowedExtensions = {
    jpg: "jpg",
    png: "png",
    webp: "webp",
  };

  if (!detected || !allowedExtensions[detected.ext]) {
    const error = new Error("Nội dung ảnh không hợp lệ");

    error.statusCode = 400;
    throw error;
  }

  await ensureDirectory();

  const fileName = `${Date.now()}_${crypto.randomUUID()}.${allowedExtensions[detected.ext]}`;

  const absolutePath = path.join(PERSON_DIR, fileName);

  await fs.promises.writeFile(absolutePath, file.buffer, { flag: "wx" });

  return {
    fileName,
    relativePath: `persons/${fileName}`,
    absolutePath,
  };
};

const deleteUploadedFile = async (relativePath) => {
  if (!relativePath) return;

  const normalized = relativePath.replace(/\\/g, "/");

  if (!/^persons\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/i.test(normalized)) {
    return;
  }

  const absolutePath = path.resolve(UPLOAD_ROOT, normalized);

  if (!absolutePath.startsWith(PERSON_DIR + path.sep)) {
    return;
  }

  try {
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("DELETE IMAGE ERROR:", error.message);
    }
  }
};

module.exports = {
  savePersonAvatar,
  deleteUploadedFile,
};
