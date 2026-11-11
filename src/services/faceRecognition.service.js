const { pool } = require("../config/database");
const { getHuman, analyzeFrame } = require("./faceAI.service");

const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.65);
const UNCERTAIN_THRESHOLD = Number(process.env.FACE_UNCERTAIN_THRESHOLD || 0.5);
const PROFILE_CACHE_MS = 30000;

let profileCache = [];
let profileCacheAt = 0;
let profileLoading = null;

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

async function getActiveProfiles(force = false) {
  if (
    !force &&
    profileCache.length &&
    Date.now() - profileCacheAt < PROFILE_CACHE_MS
  ) {
    return profileCache;
  }

  if (profileLoading) return profileLoading;

  profileLoading = (async () => {
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
      WHERE fp.status = 'active'
        AND p.status = 'active'
        AND fp.embedding IS NOT NULL
    `);

    profileCache = rows
      .map((row) => ({
        ...row,
        parsedEmbedding: parseEmbedding(row.embedding),
      }))
      .filter((row) => row.parsedEmbedding);

    profileCacheAt = Date.now();

    return profileCache;
  })().finally(() => {
    profileLoading = null;
  });

  return profileLoading;
}

function createUnknownResult(face, message = "Không nhận diện được người này") {
  return {
    status: "unknown",
    personDetected: true,
    faceDetected: true,
    faceCount: 1,
    message,
    similarity: 0,
    detectionScore: face.score,
    person: null,
    candidates: [],
    box: face.box,
    faceIndex: face.index,
  };
}

async function compareFace(face, profiles, human) {
  if (!face.embedding) {
    return {
      ...createUnknownResult(face, "Khuôn mặt chưa đủ rõ để nhận diện"),
      status: "unverified",
      faceDetected: true,
    };
  }

  if (!profiles.length) {
    return createUnknownResult(face, "Chưa có dữ liệu khuôn mặt để đối chiếu");
  }

  const personMatches = new Map();

  for (const row of profiles) {
    if (row.parsedEmbedding.length !== face.embedding.length) continue;

    const similarity = human.match.similarity(
      face.embedding,
      row.parsedEmbedding,
    );

    if (!Number.isFinite(similarity)) continue;

    const old = personMatches.get(row.person_id);

    if (!old || similarity > old.similarity) {
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
    return createUnknownResult(face, "Không có mẫu khuôn mặt hợp lệ");
  }

  const best = ranked[0];

  let status = "unknown";
  let message = "Không nhận diện được người này";

  if (best.similarity >= MATCH_THRESHOLD) {
    status = "known";
    message = "Tìm thấy hồ sơ phù hợp";
  } else if (best.similarity >= UNCERTAIN_THRESHOLD) {
    status = "uncertain";
    message = "Kết quả chưa đủ chắc chắn";
  }

  return {
    status,
    personDetected: true,
    faceDetected: true,
    faceCount: 1,
    message,
    similarity: Number(best.similarity.toFixed(4)),
    detectionScore: face.score,
    person:
      status === "known"
        ? {
            id: best.person_id,
            person_code: best.person_code,
            full_name: best.full_name,
            category: best.category,
          }
        : null,
    candidates: ranked.slice(0, 3).map((item) => ({
      person_id: item.person_id,
      person_code: item.person_code,
      full_name: item.full_name,
      similarity: Number(item.similarity.toFixed(4)),
    })),
    box: face.box,
    faceIndex: face.index,
  };
}

async function matchFace(imageBuffer) {
  const detected = await analyzeFrame(imageBuffer);

  if (!detected.personDetected) {
    return {
      status: "no_person",
      personDetected: false,
      faceDetected: false,
      faceCount: 0,
      bodyCount: 0,
      bodies: [],
      faces: [],
      faceMatches: [],
      message: "Không phát hiện người",
      similarity: 0,
      person: null,
      candidates: [],
    };
  }

  const facesWithEmbedding = detected.faces.filter((face) => face.embedding);

  let faceMatches = [];

  if (facesWithEmbedding.length) {
    const [profiles, human] = await Promise.all([
      getActiveProfiles(),
      getHuman(),
    ]);

    faceMatches = await Promise.all(
      detected.faces.map((face) => compareFace(face, profiles, human)),
    );
  } else {
    faceMatches = detected.faces.map((face) => compareFace(face, [], null));
  }

  const firstMatch =
    faceMatches.find((item) => item.status !== "unverified") ||
    faceMatches[0] ||
    null;

  return {
    ...(firstMatch || {
      status: "unknown",
      person: null,
      similarity: 0,
      candidates: [],
      message: detected.message,
    }),

    personDetected: true,
    faceDetected: detected.faceCount > 0,

    bodyCount: detected.bodyCount,
    faceCount: detected.faceCount,

    bodies: detected.bodies,
    faces: detected.faces,
    faceMatches,

    modelName: detected.modelName,
    imageWidth: detected.imageWidth,
    imageHeight: detected.imageHeight,
  };
}

async function recognizeFace(imageBuffer, options = {}) {
  const result = await matchFace(imageBuffer);

  if (options.persist !== true || result.status === "no_person") {
    return result;
  }

  const { recordRecognitionEvent } = require("./recognitionEvent.service");

  const history = await recordRecognitionEvent({
    imageBuffer,
    result,
    cameraId: options.cameraId ?? null,
    notifyTelegram: true,
  });

  return { ...result, history };
}

function invalidateProfileCache() {
  profileCache = [];
  profileCacheAt = 0;
}

module.exports = {
  recognizeFace,
  matchFace,
  invalidateProfileCache,
};
