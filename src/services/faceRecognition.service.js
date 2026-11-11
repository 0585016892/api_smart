const { pool } = require("../config/database");
const { getHuman, analyzeFrame } = require("./faceAI.service");
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
 * Phân tích frame và nhận diện người.
 */
async function matchFace(imageBuffer) {
  const detected = await analyzeFrame(imageBuffer);

  if (!detected.personDetected) {
    return {
      status: "no_person",
      personDetected: false,
      faceDetected: false,
      faceCount: 0,
      message: "Không phát hiện người",
      similarity: 0,
      person: null,
      candidates: [],
    };
  }

  // Có người nhưng không có khuôn mặt hoặc mặt không đủ rõ.
  if (!detected.embedding) {
    return {
      status: "unknown",
      personDetected: true,
      faceDetected: detected.faceCount > 0,
      faceCount: detected.faceCount,
      message: detected.message,
      similarity: 0,
      detectionScore: detected.detectionScore,
      person: null,
      candidates: [],
    };
  }

  const [rows] = await pool.query(`
    SELECT
      fp.id AS face_profile_id,
      fp.embedding,
      p.id AS person_id,
      p.person_code,
      p.full_name,
      p.category
    FROM face_profiles fp
    INNER JOIN persons p ON p.id = fp.person_id
    WHERE
      fp.status = 'active'
      AND p.status = 'active'
      AND fp.embedding IS NOT NULL
  `);

  if (!rows.length) {
    return {
      status: "unknown",
      personDetected: true,
      faceDetected: true,
      faceCount: detected.faceCount,
      message: "Chưa có dữ liệu khuôn mặt để đối chiếu",
      similarity: 0,
      detectionScore: detected.detectionScore,
      person: null,
      candidates: [],
    };
  }

  const human = await getHuman();
  const personMatches = new Map();

  for (const row of rows) {
    const storedEmbedding = parseEmbedding(row.embedding);

    if (
      !storedEmbedding ||
      storedEmbedding.length !== detected.embedding.length
    ) {
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

  const ranked = [...personMatches.values()].sort(
    (a, b) => b.similarity - a.similarity,
  );

  if (!ranked.length) {
    return {
      status: "unknown",
      personDetected: true,
      faceDetected: true,
      faceCount: detected.faceCount,
      message: "Không có mẫu khuôn mặt hợp lệ để đối chiếu",
      similarity: 0,
      detectionScore: detected.detectionScore,
      person: null,
      candidates: [],
    };
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

  return {
    status,
    personDetected: true,
    faceDetected: true,
    faceCount: detected.faceCount,
    message,
    similarity: Number(bestMatch.similarity.toFixed(4)),
    detectionScore: detected.detectionScore,

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
}

/**
 * Giữ tương thích API cũ.
 */
async function recognizeFace(imageBuffer, options = {}) {
  const result = await matchFace(imageBuffer);

  if (options.persist === false || result.status === "no_person") {
    return result;
  }

  const history = await recordRecognitionEvent({
    imageBuffer,
    result,
    cameraId: options.cameraId ?? null,
  });

  return {
    ...result,
    history,
  };
}

module.exports = {
  recognizeFace,
  matchFace,
};
