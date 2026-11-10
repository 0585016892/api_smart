const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FileType = require("file-type");

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || "uploads");

const FACE_ROOT = path.join(UPLOAD_ROOT, "faces");

const ALLOWED_EXTENSIONS = {
  jpg: "jpg",
  png: "png",
  webp: "webp",
};

async function saveFaceImage(buffer, personId) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error("File ảnh không hợp lệ");
  }

  const fileType = await FileType.fromBuffer(buffer);

  if (!fileType || !ALLOWED_EXTENSIONS[fileType.ext]) {
    throw new Error("Chỉ chấp nhận ảnh JPG, PNG hoặc WEBP");
  }

  const extension = ALLOWED_EXTENSIONS[fileType.ext];

  const personDirectory = path.join(FACE_ROOT, `person_${personId}`);

  await fs.promises.mkdir(personDirectory, {
    recursive: true,
  });

  const filename = `${Date.now()}_${crypto.randomUUID()}.${extension}`;

  const absolutePath = path.join(personDirectory, filename);

  await fs.promises.writeFile(absolutePath, buffer);

  return {
    filename,
    absolutePath,
    relativePath: path.relative(UPLOAD_ROOT, absolutePath).replace(/\\/g, "/"),
  };
}

async function deleteFaceImage(relativePath) {
  if (!relativePath) return;

  const absolutePath = path.resolve(UPLOAD_ROOT, relativePath);

  const relative = path.relative(FACE_ROOT, absolutePath);

  // Không cho phép xóa file nằm ngoài thư mục faces
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Đường dẫn ảnh không hợp lệ");
  }

  try {
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

module.exports = {
  saveFaceImage,
  deleteFaceImage,
};
