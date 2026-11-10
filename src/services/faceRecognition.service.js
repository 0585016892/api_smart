const { pool } = require("../config/database");
const { getHuman, extractFaceEmbedding } = require("./faceAI.service");
const { recordRecognitionEvent } = require("./recognitionEvent.service");

const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.65);
const UNCERTAIN_THRESHOLD = Number(process.env.FACE_UNCERTAIN_THRESHOLD || 0.5);

function parseEmbedding(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;

    if (
      !Array.isArray(parsed) ||
      parsed.length < 64 ||
      !parsed.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Sau khi nhận diện, tự động lưu lịch sử và snapshot.
 */
async function saveRecognitionResult(result, imageBuffer, cameraId) {
  const history = await recordRecognitionEvent({
    imageBuffer,
    result,
    cameraId,
  });

  return {
    ...result,
    history,
  };
}

async function recognizeFace(imageBuffer, options = {}) {
  const cameraId = options.cameraId ?? null;

  // 1. Trích xuất embedding của ảnh cần kiểm tra.
  const detected = await extractFaceEmbedding(imageBuffer);

  // 2. Lấy các mẫu khuôn mặt đang hoạt động.
  const [rows] = await pool.query(`
    SELECT
      fp.id AS face_profile_id,
      fp.embedding,
      p.id AS person_id,
      p.person_code,
      p.full_name,
      p.category
    FROM face_profiles fp
    INNER JOIN persons p
      ON p.id = fp.person_id
    WHERE
      fp.status = 'active'
      AND p.status = 'active'
      AND fp.embedding IS NOT NULL
  `);

  // 3. Chưa có dữ liệu khuôn mặt.
  if (!rows.length) {
    const result = {
      status: "unknown",
      message: "Chưa có dữ liệu khuôn mặt để đối chiếu",
      similarity: 0,
      person: null,
      candidates: [],
    };

    return saveRecognitionResult(result, imageBuffer, cameraId);
  }

  const human = await getHuman();

  // 4. So sánh với từng ảnh mẫu.
  const personMatches = new Map();

  for (const row of rows) {
    const storedEmbedding = parseEmbedding(row.embedding);

    if (!storedEmbedding) continue;

    if (storedEmbedding.length !== detected.embedding.length) {
      continue;
    }

    const similarity = human.match.similarity(
      detected.embedding,
      storedEmbedding,
    );

    if (!Number.isFinite(similarity)) continue;

    const oldMatch = personMatches.get(row.person_id);

    if (!oldMatch || similarity > oldMatch.similarity) {
      personMatches.set(row.person_id, {
        person_id: row.person_id,
        person_code: row.person_code,
        full_name: row.full_name,
        category: row.category,
        face_profile_id: row.face_profile_id,
        similarity,
      });
    }
  }

  // 5. Xếp hạng kết quả.
  const ranked = [...personMatches.values()].sort(
    (a, b) => b.similarity - a.similarity,
  );

  if (!ranked.length) {
    const result = {
      status: "unknown",
      message: "Không có mẫu khuôn mặt hợp lệ để đối chiếu",
      similarity: 0,
      person: null,
      candidates: [],
    };

    return saveRecognitionResult(result, imageBuffer, cameraId);
  }

  const bestMatch = ranked[0];

  let status = "unknown";
  let message = "Không nhận diện được người này";

  if (bestMatch.similarity >= MATCH_THRESHOLD) {
    status = "known";
    message = "Tìm thấy hồ sơ phù hợp";
  } else if (bestMatch.similarity >= UNCERTAIN_THRESHOLD) {
    status = "uncertain";
    message = "Kết quả chưa đủ chắc chắn, cần kiểm tra";
  }

  const result = {
    status,
    message,
    similarity: Number(bestMatch.similarity.toFixed(4)),

    person:
      status === "unknown"
        ? null
        : {
            id: bestMatch.person_id,
            person_code: bestMatch.person_code,
            full_name: bestMatch.full_name,
            category: bestMatch.category,
          },

    candidates: ranked.slice(0, 3).map((item) => ({
      person_id: item.person_id,
      person_code: item.person_code,
      full_name: item.full_name,
      similarity: Number(item.similarity.toFixed(4)),
    })),
  };

  // 6. Lưu sự kiện, snapshot và cập nhật phiên xuất hiện.
  return saveRecognitionResult(result, imageBuffer, cameraId);
}

module.exports = {
  recognizeFace,
};
