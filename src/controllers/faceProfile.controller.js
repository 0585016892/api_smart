const { pool } = require("../config/database");

const {
  extractFaceEmbedding,
  MODEL_NAME,
} = require("../services/faceAI.service");

const { saveFaceImage, deleteFaceImage } = require("../utils/faceStorage");

// Lấy danh sách ảnh mẫu của một người
async function getFaceProfiles(req, res, next) {
  try {
    const personId = Number(req.params.personId);

    if (!Number.isInteger(personId) || personId <= 0) {
      return res.status(400).json({
        success: false,
        message: "ID người không hợp lệ",
      });
    }

    const [persons] = await pool.query(
      `SELECT id, full_name
       FROM persons
       WHERE id = ?
       LIMIT 1`,
      [personId],
    );

    if (!persons.length) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy hồ sơ người này",
      });
    }

    const [rows] = await pool.query(
      `SELECT
          id,
          person_id,
          image_path,
          model_name,
          image_quality,
          status,
          created_at
       FROM face_profiles
       WHERE person_id = ?
       ORDER BY id DESC`,
      [personId],
    );

    return res.json({
      success: true,
      data: {
        person: persons[0],
        profiles: rows,
        total: rows.length,
      },
    });
  } catch (error) {
    next(error);
  }
}

// Đăng ký nhiều ảnh khuôn mặt
async function createFaceProfiles(req, res, next) {
  const personId = Number(req.params.personId);
  const files = req.files || [];

  if (!Number.isInteger(personId) || personId <= 0) {
    return res.status(400).json({
      success: false,
      message: "ID người không hợp lệ",
    });
  }

  if (!files.length) {
    return res.status(400).json({
      success: false,
      message: "Vui lòng chọn ít nhất một ảnh",
    });
  }

  const savedProfiles = [];
  const failedProfiles = [];

  try {
    const [persons] = await pool.query(
      `SELECT id, full_name
       FROM persons
       WHERE id = ?
       LIMIT 1`,
      [personId],
    );

    if (!persons.length) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy hồ sơ người này",
      });
    }

    for (const file of files) {
      let storedImage = null;

      try {
        // 1. Trích xuất embedding trước khi lưu ảnh
        const faceData = await extractFaceEmbedding(file.buffer);

        // 2. Lưu ảnh vào thư mục riêng của người
        storedImage = await saveFaceImage(file.buffer, personId);

        // 3. Lưu dữ liệu vào MySQL
        const [result] = await pool.query(
          `INSERT INTO face_profiles (
            person_id,
            image_path,
            embedding,
            model_name,
            image_quality,
            status
          ) VALUES (?, ?, ?, ?, ?, 'active')`,
          [
            personId,
            storedImage.relativePath,
            JSON.stringify(faceData.embedding),
            faceData.modelName,
            faceData.detectionScore,
          ],
        );

        savedProfiles.push({
          id: result.insertId,
          image_path: storedImage.relativePath,
          image_quality: faceData.detectionScore,
          model_name: MODEL_NAME,
        });
      } catch (error) {
        // Nếu đã lưu file nhưng DB lỗi thì xóa file
        if (storedImage) {
          await deleteFaceImage(storedImage.relativePath).catch(() => {});
        }

        failedProfiles.push({
          filename: file.originalname,
          message: error.message || "Không xử lý được ảnh",
        });
      }
    }

    const hasSuccess = savedProfiles.length > 0;

    return res.status(hasSuccess ? 201 : 422).json({
      success: hasSuccess,
      message: hasSuccess
        ? "Đã xử lý xong ảnh khuôn mặt"
        : "Không có ảnh nào được đăng ký thành công",

      data: {
        person: persons[0],
        total_uploaded: files.length,
        total_success: savedProfiles.length,
        total_failed: failedProfiles.length,
        profiles: savedProfiles,
        errors: failedProfiles,
      },
    });
  } catch (error) {
    next(error);
  }
}

// Xóa một ảnh mẫu
async function deleteFaceProfile(req, res, next) {
  try {
    const personId = Number(req.params.personId);
    const faceId = Number(req.params.faceId);

    if (
      !Number.isInteger(personId) ||
      personId <= 0 ||
      !Number.isInteger(faceId) ||
      faceId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "ID không hợp lệ",
      });
    }

    const [rows] = await pool.query(
      `SELECT id, image_path
       FROM face_profiles
       WHERE id = ? AND person_id = ?
       LIMIT 1`,
      [faceId, personId],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy ảnh mẫu",
      });
    }

    // Xóa bản ghi trước để không giữ dữ liệu mồ côi
    await pool.query(
      `DELETE FROM face_profiles
       WHERE id = ? AND person_id = ?`,
      [faceId, personId],
    );

    await deleteFaceImage(rows[0].image_path);

    return res.json({
      success: true,
      message: "Đã xóa ảnh khuôn mặt",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getFaceProfiles,
  createFaceProfiles,
  deleteFaceProfile,
};
