// src/services/cameraStream.service.js

const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const { pool } = require("../config/database");
const { matchFace } = require("./faceRecognition.service");
const { recordRecognitionEvent } = require("./recognitionEvent.service");

// ======================================================
// CONFIG
// ======================================================

const SYNC_INTERVAL = Math.max(
  Number(process.env.CAMERA_SYNC_INTERVAL || 5000),
  1000,
);

const CAMERA_STREAM_FPS = Math.max(
  Number(process.env.CAMERA_STREAM_FPS || 5),
  1,
);

const CAMERA_AI_INTERVAL_MS = Math.max(
  Number(process.env.CAMERA_AI_INTERVAL_MS || 500),
  100,
);

// Mất dấu liên tục đủ 10 giây thì kết thúc lượt xuất hiện.
const PRESENCE_EXIT_GRACE_MS = Math.max(
  Number(process.env.CAMERA_PRESENCE_EXIT_SECONDS || 10) * 1000,
  5000,
);

const MAX_BUFFER_SIZE = 15 * 1024 * 1024;
const ERROR_LOG_INTERVAL = 30000;

const TRACK_IOU_THRESHOLD = 0.12;
const TRACK_DISTANCE_RATIO = 0.65;

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

const FFMPEG_LOG_LEVEL = process.env.CAMERA_FFMPEG_LOG_LEVEL || "warning";

const RESTART_BASE_DELAY_MS = 5000;
const RESTART_MAX_DELAY_MS = 60000;
const RESTART_STABLE_TIME_MS = 30000;

const STDERR_BUFFER_LIMIT = 12000;
const STDERR_LOG_INTERVAL = 3000;

// ======================================================
// GLOBAL STATE
// ======================================================

const workers = new Map();

let syncTimer = null;
let syncing = false;
let serviceStarted = false;

// ======================================================
// COMMON HELPERS
// ======================================================

function toNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseConfig(camera) {
  const config = safeJsonParse(
    camera.config || camera.settings || camera.camera_config,
    {},
  );

  return {
    ...config,
    ...camera,
  };
}

function getCameraId(camera) {
  return camera.id ?? camera.camera_id;
}

function getConnectionConfig(camera) {
  return safeJsonParse(camera.connection_config, {});
}

function getCameraSourceType(camera) {
  const config = getConnectionConfig(camera);
  const protocol = String(camera.protocol || "").toLowerCase();

  if (
    config.source === "browser_webcam" ||
    config.capture_mode === "browser" ||
    config.source === "webcam"
  ) {
    return "browser_webcam";
  }

  if (protocol === "upload" || config.source === "upload") {
    return "upload";
  }

  if (
    protocol === "rtsp" ||
    config.url ||
    config.rtsp_url ||
    config.host ||
    camera.ip_address
  ) {
    return "rtsp";
  }

  if (protocol === "onvif" || protocol === "ezviz") {
    return "unsupported";
  }

  return "unsupported";
}

function getCameraConfigSignature(camera) {
  const config = getConnectionConfig(camera);

  return JSON.stringify({
    protocol: camera.protocol || null,
    connection_config: config,
    ip_address: camera.ip_address || null,
    is_enabled: camera.is_enabled,
  });
}

function isCameraEnabled(camera) {
  const value =
    camera.is_enabled ?? camera.enabled ?? camera.active ?? camera.status;

  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1;
  }

  return ["1", "true", "active", "enabled", "online"].includes(
    String(value).toLowerCase(),
  );
}

function safeError(error) {
  if (!error) return "Unknown error";

  return String(error.message || error)
    .replace(/rtsp:\/\/[^@\s]+@/gi, "rtsp://***@")
    .slice(0, 1000);
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/(rtsp:\/\/)[^@\s]+@/gi, "$1***@")
    .replace(/(password|passwd|pwd)=([^&\s]+)/gi, "$1=***")
    .slice(0, 3000);
}

function formatExitCode(code) {
  if (code === null || code === undefined) {
    return {
      code: null,
      hex: null,
      signed: null,
    };
  }

  const unsigned = Number(code) >>> 0;

  return {
    code,
    hex: `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`,
    signed: unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned,
  };
}

function getRestartDelay(worker) {
  const attempt = Math.max(0, worker.restartAttempts || 0);

  return Math.min(
    RESTART_BASE_DELAY_MS * Math.pow(2, Math.min(attempt, 4)),
    RESTART_MAX_DELAY_MS,
  );
}

function appendFfmpegStderr(worker, text) {
  const message = redactSensitiveText(text).trim();

  if (!message) return;

  worker.stderrTail = `${worker.stderrTail || ""}\n${message}`;

  if (worker.stderrTail.length > STDERR_BUFFER_LIMIT) {
    worker.stderrTail = worker.stderrTail.slice(-STDERR_BUFFER_LIMIT);
  }

  const now = Date.now();

  if (now - (worker.lastFfmpegLogAt || 0) >= STDERR_LOG_INTERVAL) {
    console.error(`[CAMERA ${worker.id}] FFMPEG STDERR:\n${message}`);

    worker.lastFfmpegLogAt = now;
  }
}

// ======================================================
// CAMERA RTSP CONFIG
// ======================================================

function buildRtspUrl(camera) {
  const config = getConnectionConfig(camera);
  const sourceType = getCameraSourceType(camera);

  if (sourceType !== "rtsp") {
    return null;
  }

  // Ưu tiên URL RTSP đầy đủ.
  const rtspUrl = config.rtsp_url || config.url;

  if (rtspUrl) {
    if (!/^rtsps?:\/\//i.test(rtspUrl)) {
      throw new Error(`Camera ${getCameraId(camera)} có URL RTSP không hợp lệ`);
    }

    return rtspUrl;
  }

  const host = config.host || camera.ip_address;

  if (!host) {
    throw new Error(
      `Camera ${getCameraId(camera)} không có địa chỉ IP hoặc RTSP URL`,
    );
  }

  const port = config.port || 554;

  const username = config.username || "";
  const password = config.password || "";

  const streamPath = config.stream_path || "/Streaming/Channels/101";

  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : "";

  return `rtsp://${auth}${host}:${port}${streamPath}`;
}

/**
 * FFmpeg arguments.
 *
 * Không sử dụng -stimeout hoặc -timeout vì phiên bản
 * ffmpeg-static đang chạy có thể không hỗ trợ tùy chọn đó.
 *
 * RTSP vẫn sử dụng TCP như cấu hình camera đã kiểm tra.
 */
function getFfmpegArgs(rtspUrl) {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    FFMPEG_LOG_LEVEL,

    "-rtsp_transport",
    "tcp",

    "-i",
    rtspUrl,

    "-an",
    "-sn",
    "-dn",

    "-vf",
    `fps=${CAMERA_STREAM_FPS}`,

    "-q:v",
    "5",

    "-f",
    "image2pipe",

    "-vcodec",
    "mjpeg",

    "pipe:1",
  ];
}

// ======================================================
// JPEG FRAME EXTRACTION
// ======================================================

function extractJpegs(buffer) {
  const frames = [];

  let remaining = buffer;

  while (remaining.length > 0) {
    const start = remaining.indexOf(JPEG_START);

    if (start < 0) {
      return {
        frames,
        remaining: remaining.slice(-1),
      };
    }

    const end = remaining.indexOf(JPEG_END, start + 2);

    if (end < 0) {
      return {
        frames,
        remaining: remaining.slice(start),
      };
    }

    const frame = remaining.subarray(start, end + 2);

    frames.push(frame);

    remaining = remaining.subarray(end + 2);
  }

  return {
    frames,
    remaining,
  };
}

// ======================================================
// BOX HELPERS
// ======================================================

function normalizeBox(box) {
  if (!box) return null;

  const left = toNumber(box.left ?? box.x ?? box.x1, NaN);

  const top = toNumber(box.top ?? box.y ?? box.y1, NaN);

  let right = toNumber(box.right ?? box.x2, NaN);

  let bottom = toNumber(box.bottom ?? box.y2, NaN);

  let width = toNumber(box.width, NaN);
  let height = toNumber(box.height, NaN);

  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }

  if (!Number.isFinite(right) && Number.isFinite(width)) {
    right = left + width;
  }

  if (!Number.isFinite(bottom) && Number.isFinite(height)) {
    bottom = top + height;
  }

  if (!Number.isFinite(right) || !Number.isFinite(bottom)) {
    return null;
  }

  width = right - left;
  height = bottom - top;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    centerX: left + width / 2,
    centerY: top + height / 2,
  };
}

function calculateIoU(a, b) {
  if (!a || !b) return 0;

  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);

  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  const intersection = width * height;

  const areaA = a.width * a.height;
  const areaB = b.width * b.height;

  const union = areaA + areaB - intersection;

  return union > 0 ? intersection / union : 0;
}

function calculateCenterDistance(a, b) {
  if (!a || !b) return Infinity;

  const dx = a.centerX - b.centerX;
  const dy = a.centerY - b.centerY;

  return Math.sqrt(dx * dx + dy * dy);
}

function isPointInsideBox(pointX, pointY, box) {
  if (!box) return false;

  return (
    pointX >= box.left &&
    pointX <= box.right &&
    pointY >= box.top &&
    pointY <= box.bottom
  );
}

// ======================================================
// DETECTION HELPERS
// ======================================================

function getFaceBox(face) {
  return normalizeBox(face.box || face.boundingBox || face.region || face);
}

function getBodyBox(body) {
  return normalizeBox(body.box || body.boundingBox || body.region || body);
}

function buildPersonDetections(bodies = [], faces = []) {
  const normalizedBodies = bodies
    .map((body, index) => ({
      type: "body",
      index,
      box: getBodyBox(body),
      score: toNumber(body.score, 0),
      source: body,
    }))
    .filter((item) => item.box);

  const normalizedFaces = faces
    .map((face, index) => ({
      type: "face",
      index,
      box: getFaceBox(face),
      score: toNumber(face.score, 0),
      source: face,
    }))
    .filter((item) => item.box);

  const assignedFaceIndexes = new Set();

  const detections = normalizedBodies.map((body) => {
    const candidates = normalizedFaces
      .filter((face) => {
        if (assignedFaceIndexes.has(face.index)) {
          return false;
        }

        return isPointInsideBox(face.box.centerX, face.box.centerY, body.box);
      })
      .sort((a, b) => b.score - a.score);

    const selectedFace = candidates[0] || null;

    if (selectedFace) {
      assignedFaceIndexes.add(selectedFace.index);
    }

    return {
      type: "body",
      box: body.box,
      score: body.score,
      face: selectedFace?.source || null,
      faceBox: selectedFace?.box || null,
      faceIndex: selectedFace?.index ?? null,
    };
  });

  normalizedFaces.forEach((face) => {
    if (assignedFaceIndexes.has(face.index)) {
      return;
    }

    detections.push({
      type: "face",
      box: face.box,
      score: face.score,
      face: face.source,
      faceBox: face.box,
      faceIndex: face.index,
    });
  });

  return detections;
}

// ======================================================
// TRACK MANAGEMENT
// ======================================================

function createTrack(worker, detection, now) {
  worker.trackSequence += 1;

  return {
    id: `CAM-${worker.id}-TRACK-${worker.trackSequence}`,

    box: detection.box,
    detectionType: detection.type,

    firstSeenAt: now,
    lastSeenAt: now,

    status: "unknown",
    person: null,
    similarity: null,

    faceDetected: Boolean(detection.face),
    faceScore: detection.face ? toNumber(detection.face.score, 0) : 0,

    latestFaceResult: null,

    eventSaved: false,
    notificationAttempted: false,

    sessionStartedAt: now,
    lastEventAt: null,
  };
}

function updateTrack(track, detection, now) {
  track.box = detection.box;
  track.detectionType = detection.type;
  track.lastSeenAt = now;

  if (detection.face) {
    track.faceDetected = true;

    track.faceScore = toNumber(detection.face.score, track.faceScore);
  }
}

function calculateTrackMatchScore(track, detection) {
  const oldBox = track.box;
  const newBox = detection.box;

  if (!oldBox || !newBox) return null;

  const iou = calculateIoU(oldBox, newBox);

  const distance = calculateCenterDistance(oldBox, newBox);

  const diagonal = Math.max(
    Math.sqrt(oldBox.width * oldBox.width + oldBox.height * oldBox.height),
    1,
  );

  const distanceRatio = distance / diagonal;

  // Track khuôn mặt chuyển thành track toàn thân.
  if (
    track.detectionType === "face" &&
    detection.type === "body" &&
    isPointInsideBox(oldBox.centerX, oldBox.centerY, newBox)
  ) {
    return 0.9;
  }

  // Track toàn thân chuyển thành track khuôn mặt.
  if (
    track.detectionType === "body" &&
    detection.type === "face" &&
    isPointInsideBox(newBox.centerX, newBox.centerY, oldBox)
  ) {
    return 0.85;
  }

  if (iou < TRACK_IOU_THRESHOLD && distanceRatio > TRACK_DISTANCE_RATIO) {
    return null;
  }

  return iou * 0.7 + Math.max(0, 1 - distanceRatio) * 0.3;
}

function matchBodyDetections(worker, detections, now) {
  const tracks = [...worker.tracks.values()];

  const candidates = [];

  tracks.forEach((track) => {
    detections.forEach((detection, detectionIndex) => {
      const score = calculateTrackMatchScore(track, detection);

      if (score === null) return;

      candidates.push({
        track,
        detection,
        detectionIndex,
        score,
      });
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  const matchedTracks = new Set();
  const matchedDetections = new Set();

  const assignments = [];

  candidates.forEach((candidate) => {
    if (matchedTracks.has(candidate.track.id)) {
      return;
    }

    if (matchedDetections.has(candidate.detectionIndex)) {
      return;
    }

    matchedTracks.add(candidate.track.id);
    matchedDetections.add(candidate.detectionIndex);

    updateTrack(candidate.track, candidate.detection, now);

    assignments.push({
      track: candidate.track,
      detection: candidate.detection,
    });
  });

  detections.forEach((detection, index) => {
    if (matchedDetections.has(index)) return;

    const track = createTrack(worker, detection, now);

    worker.tracks.set(track.id, track);

    assignments.push({
      track,
      detection,
    });

    console.log(`[CAMERA ${worker.id}] TRACK CREATED: ${track.id}`);
  });

  return assignments;
}

/**
 * Xóa track khi người đó đã vắng mặt liên tục đủ thời gian.
 *
 * Nếu người quay lại trước 10 giây:
 * - Vẫn sử dụng track cũ.
 * - Không tạo sự kiện mới.
 *
 * Nếu người quay lại sau 10 giây:
 * - Track cũ đã bị xóa.
 * - Tạo track mới.
 * - Có thể ghi nhận một lượt xuất hiện mới.
 */
function removeExpiredTracks(worker, now) {
  for (const [trackId, track] of worker.tracks.entries()) {
    const absentDuration = now - track.lastSeenAt;

    if (absentDuration < PRESENCE_EXIT_GRACE_MS) {
      continue;
    }

    worker.tracks.delete(trackId);

    console.log(`[CAMERA ${worker.id}] TRACK EXPIRED`, {
      trackingId: trackId,
      absentDurationMs: absentDuration,
    });
  }
}

// ======================================================
// LIVE SNAPSHOT HELPERS
// ======================================================

function serializeTrack(track) {
  return {
    tracking_id: track.id,
    status: track.status,
    person: track.person,
    similarity: track.similarity,
    face_detected: track.faceDetected,
    face_score: track.faceScore,
    event_saved: track.eventSaved,

    box: track.box
      ? {
          left: track.box.left,
          top: track.box.top,
          right: track.box.right,
          bottom: track.box.bottom,
          width: track.box.width,
          height: track.box.height,
          centerX: track.box.centerX,
          centerY: track.box.centerY,
        }
      : null,

    first_seen_at: track.firstSeenAt
      ? new Date(track.firstSeenAt).toISOString()
      : null,

    last_seen_at: track.lastSeenAt
      ? new Date(track.lastSeenAt).toISOString()
      : null,
  };
}

/**
 * Lưu ảnh và tracks của cùng một frame.
 * Chỉ lấy tracks thực sự được phát hiện trong frame hiện tại.
 */
function updateLiveSnapshot(worker, imageBuffer, capturedAt, detectedAt) {
  worker.frameSequence += 1;

  const tracks = [...worker.tracks.values()]
    .filter((track) => track.lastSeenAt === detectedAt)
    .map(serializeTrack);

  worker.latestSnapshot = {
    frameId: worker.frameSequence,
    capturedAt,
    processedAt: detectedAt,

    imageWidth: worker.imageWidth,
    imageHeight: worker.imageHeight,

    frame: imageBuffer,
    tracks,
    personCount: tracks.length,
  };
}

// ======================================================
// FACE RESULT ASSOCIATION
// ======================================================

function getRecognitionStatus(result) {
  const status = String(result?.status || "").toLowerCase();

  if (status === "known") return "known";
  if (status === "uncertain") return "uncertain";
  if (status === "unknown") return "unknown";

  return null;
}

function buildTrackRecognitionResult(result, detection) {
  if (!result) return null;

  const faceMatches = result.faceMatches || [];

  if (faceMatches.length && detection.faceIndex !== null) {
    const faceMatch = faceMatches.find(
      (item, index) =>
        item.index === detection.faceIndex ||
        item.faceIndex === detection.faceIndex ||
        index === detection.faceIndex,
    );

    if (faceMatch) {
      return {
        ...result,
        ...faceMatch,

        status: getRecognitionStatus(faceMatch) || result.status,

        person: faceMatch.person || result.person || null,

        similarity: faceMatch.similarity ?? result.similarity ?? null,

        faceDetected: true,
        faceCount: 1,
      };
    }
  }

  if (toNumber(result.faceCount, 0) <= 1 && detection.face) {
    return {
      ...result,
      faceCount: 1,
      faceDetected: true,
    };
  }

  return null;
}

// ======================================================
// SAVE RECOGNITION EVENT
// ======================================================

async function saveTrackEvent(worker, track, imageBuffer) {
  if (track.eventSaved) return;

  const result = track.latestFaceResult;

  const status = getRecognitionStatus(result);

  if (!status) return;

  if (!["known", "unknown", "uncertain"].includes(status)) {
    return;
  }

  // Đánh dấu trước khi gọi database để tránh gọi trùng.
  track.eventSaved = true;
  track.notificationAttempted = true;

  try {
    const history = await recordRecognitionEvent({
      imageBuffer,
      cameraId: worker.id,

      result: {
        ...result,
        status,
        faceCount: 1,
        faceDetected: true,
      },
    });

    track.lastEventAt = Date.now();

    console.log(`[CAMERA ${worker.id}] EVENT SAVED`, {
      trackingId: track.id,
      status,
      eventId: history?.event?.id || null,
    });
  } catch (error) {
    // Cho phép thử lại nếu lưu sự kiện thất bại.
    track.eventSaved = false;
    track.notificationAttempted = false;

    console.error(`[CAMERA ${worker.id}] SAVE EVENT ERROR:`, safeError(error));
  }
}

// ======================================================
// PROCESS AI FRAME
// ======================================================

async function processFrame(worker, imageBuffer, capturedAt = Date.now()) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    return;
  }

  const now = Date.now();

  try {
    const result = await matchFace(imageBuffer);

    // Nếu worker đang dừng thì không tiếp tục cập nhật.
    if (worker.stopping) return;

    worker.lastAiAt = now;
    worker.lastAiError = null;

    worker.imageWidth = toNumber(result?.imageWidth, 0) || worker.imageWidth;

    worker.imageHeight = toNumber(result?.imageHeight, 0) || worker.imageHeight;

    const bodies = result?.bodies || [];

    const faces = result?.faceMatches || result?.faces || [];

    const detections = buildPersonDetections(bodies, faces);

    // Xóa các track đã vắng mặt đủ 10 giây.
    removeExpiredTracks(worker, now);

    // Ghép detection với các track hiện tại.
    const assignments = matchBodyDetections(worker, detections, now);

    for (const assignment of assignments) {
      const { track, detection } = assignment;

      if (!detection.face) {
        continue;
      }

      const trackResult = buildTrackRecognitionResult(result, detection);

      if (!trackResult) continue;

      const status = getRecognitionStatus(trackResult);

      if (!status) continue;

      track.latestFaceResult = trackResult;
      track.status = status;
      track.person = trackResult.person || null;

      track.similarity = trackResult.similarity ?? null;

      track.faceDetected = true;

      track.faceScore = toNumber(detection.face.score, track.faceScore);

      if (!track.eventSaved) {
        await saveTrackEvent(worker, track, imageBuffer);
      }
    }

    worker.personCount = worker.tracks.size;

    if (detections.length > 0) {
      worker.lastPersonDetectedAt = now;
    }

    // Ảnh và tracks được lưu cùng một snapshot.
    updateLiveSnapshot(worker, imageBuffer, capturedAt, now);

    if (now - worker.lastLogAt >= 5000) {
      console.log(
        `[CAMERA ${worker.id}] AI DETECTION | Bodies: ${bodies.length} | Faces: ${faces.length} | Detections: ${detections.length} | Tracks: ${worker.tracks.size}`,
      );

      worker.lastLogAt = now;
    }
  } catch (error) {
    worker.lastAiError = safeError(error);

    if (now - worker.lastErrorLogAt >= ERROR_LOG_INTERVAL) {
      console.error(
        `[CAMERA ${worker.id}] AI FRAME ERROR:`,
        worker.lastAiError,
      );

      worker.lastErrorLogAt = now;
    }
  }
}

// ======================================================
// CAMERA WORKER
// ======================================================

function createWorker(camera) {
  const config = parseConfig(camera);

  const id = getCameraId(camera);

  return {
    id,
    camera: config,

    sourceType: getCameraSourceType(config),
    configSignature: getCameraConfigSignature(config),

    unsupported: false,
    sourceError: null,

    process: null,

    connected: false,
    processing: false,
    stopping: false,

    latestFrame: null,
    latestFrameAt: null,

    imageWidth: 0,
    imageHeight: 0,

    buffer: Buffer.alloc(0),

    tracks: new Map(),
    trackSequence: 0,

    personCount: 0,

    lastAiAt: 0,
    lastAiError: null,

    lastPersonDetectedAt: null,

    lastLogAt: 0,
    lastErrorLogAt: 0,

    lastRestartAt: 0,
    restartTimer: null,

    latestSnapshot: null,
    frameSequence: 0,

    frameQueueBusy: false,
    lastFrameProcessAt: 0,

    // FFmpeg diagnostics.
    processStartedAt: null,
    lastFfmpegLogAt: 0,
    stderrTail: "",
    restartAttempts: 0,
    lastFfmpegExit: null,
  };
}

// ======================================================
// STOP WORKER
// ======================================================

function stopWorker(worker) {
  if (!worker) return;

  worker.stopping = true;

  if (worker.restartTimer) {
    clearTimeout(worker.restartTimer);
    worker.restartTimer = null;
  }

  if (worker.process) {
    try {
      worker.process.kill("SIGTERM");
    } catch (error) {
      console.error(`[CAMERA ${worker.id}] STOP ERROR:`, safeError(error));
    }

    worker.process = null;
  }

  worker.connected = false;
  worker.processing = false;
  worker.buffer = Buffer.alloc(0);

  worker.latestFrame = null;
  worker.latestFrameAt = null;
  worker.latestSnapshot = null;

  worker.imageWidth = 0;
  worker.imageHeight = 0;

  worker.tracks.clear();
  worker.personCount = 0;
}

// ======================================================
// RESTART WORKER
// ======================================================

function scheduleWorkerRestart(worker) {
  if (!worker || worker.stopping || worker.unsupported) {
    return;
  }

  if (worker.restartTimer) return;

  const delay = getRestartDelay(worker);

  worker.restartAttempts = (worker.restartAttempts || 0) + 1;

  worker.lastRestartAt = Date.now();

  console.warn(`[CAMERA ${worker.id}] SCHEDULE RESTART`, {
    attempt: worker.restartAttempts,
    delayMs: delay,
    nextRestartAt: new Date(Date.now() + delay).toISOString(),
  });

  worker.restartTimer = setTimeout(() => {
    worker.restartTimer = null;

    if (worker.stopping || worker.process) {
      return;
    }

    startWorker(worker);
  }, delay);

  if (worker.restartTimer.unref) {
    worker.restartTimer.unref();
  }
}

// ======================================================
// START WORKER
// ======================================================

function startWorker(worker) {
  if (!worker || worker.stopping) return;
  if (worker.process) return;
  if (worker.restartTimer) return;
  if (worker.unsupported) return;

  const sourceType = getCameraSourceType(worker.camera);

  worker.sourceType = sourceType;

  if (sourceType === "browser_webcam") {
    worker.unsupported = true;
    worker.processing = false;
    worker.connected = false;

    worker.sourceError =
      "Webcam trình duyệt cần gửi frame từ frontend lên backend";

    console.log(
      `[CAMERA ${worker.id}] BROWSER WEBCAM - CHỜ FRONTEND GỬI FRAME`,
    );

    return;
  }

  if (sourceType === "upload") {
    worker.unsupported = true;
    worker.processing = false;
    worker.connected = false;

    worker.sourceError = "Camera upload không sử dụng RTSP";

    console.log(`[CAMERA ${worker.id}] UPLOAD SOURCE - BỎ QUA RTSP`);

    return;
  }

  if (sourceType !== "rtsp") {
    worker.unsupported = true;
    worker.processing = false;
    worker.connected = false;

    worker.sourceError = "Camera chưa có cấu hình RTSP được hỗ trợ";

    console.error(`[CAMERA ${worker.id}] UNSUPPORTED CAMERA SOURCE`);

    return;
  }

  if (!ffmpegPath) {
    worker.sourceError = "Không tìm thấy ffmpeg-static";

    console.error(`[CAMERA ${worker.id}] FFMPEG NOT FOUND`);

    return;
  }

  let rtspUrl;

  try {
    rtspUrl = buildRtspUrl(worker.camera);

    if (!rtspUrl) {
      throw new Error("RTSP URL rỗng");
    }
  } catch (error) {
    worker.sourceError = safeError(error);

    console.error(
      `[CAMERA ${worker.id}] RTSP CONFIG ERROR:`,
      worker.sourceError,
    );

    return;
  }

  worker.unsupported = false;
  worker.sourceError = null;
  worker.stopping = false;

  worker.buffer = Buffer.alloc(0);
  worker.stderrTail = "";
  worker.lastFfmpegLogAt = 0;

  const args = getFfmpegArgs(rtspUrl);

  const startedAt = Date.now();

  console.log(`[CAMERA ${worker.id}] STARTING FFMPEG`, {
    ffmpegPath,
    logLevel: FFMPEG_LOG_LEVEL,
    fps: CAMERA_STREAM_FPS,
    aiInterval: CAMERA_AI_INTERVAL_MS,
    transport: "tcp",
    startedAt: new Date(startedAt).toISOString(),

    // Không in URL thật vì có username/password.
    args: args.map((arg) => (arg === rtspUrl ? "[REDACTED_RTSP_URL]" : arg)),
  });

  worker.processing = true;
  worker.connected = false;
  worker.processStartedAt = startedAt;

  let ffmpeg;

  try {
    ffmpeg = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    worker.processing = false;
    worker.connected = false;
    worker.sourceError = safeError(error);

    console.error(
      `[CAMERA ${worker.id}] FFMPEG SPAWN THROW:`,
      worker.sourceError,
    );

    scheduleWorkerRestart(worker);
    return;
  }

  worker.process = ffmpeg;

  // --------------------------------------------------
  // FFMPEG SPAWN
  // --------------------------------------------------

  ffmpeg.on("spawn", () => {
    console.log(`[CAMERA ${worker.id}] FFMPEG PROCESS STARTED`, {
      pid: ffmpeg.pid || null,
      startedAt: new Date(startedAt).toISOString(),
    });
  });

  // --------------------------------------------------
  // FFMPEG STDOUT - JPEG FRAMES
  // --------------------------------------------------

  ffmpeg.stdout.on("data", (chunk) => {
    if (worker.stopping || worker.process !== ffmpeg) {
      return;
    }

    const now = Date.now();

    worker.connected = true;

    // Camera chạy ổn định 30 giây thì reset backoff.
    if (now - startedAt >= RESTART_STABLE_TIME_MS) {
      worker.restartAttempts = 0;
    }

    worker.buffer = Buffer.concat([worker.buffer, chunk]);

    // Tránh buffer tăng vô hạn khi JPEG lỗi.
    if (worker.buffer.length > MAX_BUFFER_SIZE) {
      console.warn(`[CAMERA ${worker.id}] FRAME BUFFER OVERFLOW`, {
        bufferSize: worker.buffer.length,
        maxBufferSize: MAX_BUFFER_SIZE,
      });

      worker.buffer = worker.buffer.subarray(-Math.floor(MAX_BUFFER_SIZE / 2));
    }

    const extracted = extractJpegs(worker.buffer);

    worker.buffer = extracted.remaining;

    for (const frame of extracted.frames) {
      const capturedAt = Date.now();

      worker.latestFrame = frame;
      worker.latestFrameAt = capturedAt;

      // Không xử lý nhiều frame AI cùng lúc.
      if (
        worker.frameQueueBusy ||
        capturedAt - worker.lastFrameProcessAt < CAMERA_AI_INTERVAL_MS
      ) {
        continue;
      }

      worker.frameQueueBusy = true;
      worker.lastFrameProcessAt = capturedAt;

      processFrame(worker, frame, capturedAt)
        .catch((error) => {
          console.error(
            `[CAMERA ${worker.id}] PROCESS FRAME ERROR:`,
            safeError(error),
          );
        })
        .finally(() => {
          worker.frameQueueBusy = false;
        });
    }
  });

  // --------------------------------------------------
  // FFMPEG STDERR
  // --------------------------------------------------

  ffmpeg.stderr.on("data", (data) => {
    appendFfmpegStderr(worker, data.toString());
  });

  // --------------------------------------------------
  // FFMPEG ERROR
  // --------------------------------------------------

  ffmpeg.on("error", (error) => {
    worker.sourceError = safeError(error);

    console.error(`[CAMERA ${worker.id}] FFMPEG PROCESS ERROR`, {
      message: worker.sourceError,
      pid: ffmpeg.pid || null,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
    });
  });

  // --------------------------------------------------
  // FFMPEG CLOSE
  // --------------------------------------------------

  ffmpeg.on("close", (code, signal) => {
    const closedAt = Date.now();
    const elapsedMs = closedAt - startedAt;

    const exitInfo = formatExitCode(code);

    const isCurrentProcess = worker.process === ffmpeg;

    if (isCurrentProcess) {
      worker.process = null;
    }

    worker.connected = false;
    worker.processing = false;
    worker.buffer = Buffer.alloc(0);

    worker.lastFfmpegExit = {
      ...exitInfo,
      signal: signal || null,
      elapsedMs,
      closedAt,
    };

    // Nếu tiến trình chạy ổn định đủ lâu,
    // reset thời gian backoff.
    if (elapsedMs >= RESTART_STABLE_TIME_MS) {
      worker.restartAttempts = 0;
    }

    console.error(`[CAMERA ${worker.id}] FFMPEG CLOSED`, {
      ...exitInfo,
      signal: signal || null,
      pid: ffmpeg.pid || null,
      elapsedMs,
      startedAt: new Date(startedAt).toISOString(),
      closedAt: new Date(closedAt).toISOString(),
      wasCurrentProcess: isCurrentProcess,
      stopping: worker.stopping,
      stderr: worker.stderrTail || "(FFmpeg không trả stderr)",
    });

    // Không giữ frame cũ sau khi stream chết.
    if (isCurrentProcess) {
      worker.latestFrame = null;
      worker.latestFrameAt = null;
      worker.latestSnapshot = null;
    }

    if (worker.stopping || !isCurrentProcess) {
      return;
    }

    worker.sourceError = `FFmpeg đã thoát: ${exitInfo.hex || code}, signal: ${signal || "none"}`;

    scheduleWorkerRestart(worker);
  });
}

// ======================================================
// CAMERA SYNC
// ======================================================

async function syncCameras() {
  if (syncing) return;

  syncing = true;

  try {
    const [rows] = await pool.query("SELECT * FROM cameras");

    const cameras = (rows || []).filter(isCameraEnabled);

    const activeIds = new Set(
      cameras.map((camera) => String(getCameraId(camera))),
    );

    // ----------------------------------------------
    // DỪNG CAMERA BỊ XÓA HOẶC TẮT
    // ----------------------------------------------

    for (const [id, worker] of workers.entries()) {
      if (!activeIds.has(String(id))) {
        console.log(`[CAMERA ${id}] CAMERA DISABLED`);

        stopWorker(worker);
        workers.delete(id);
      }
    }

    // ----------------------------------------------
    // ĐỒNG BỘ CAMERA
    // ----------------------------------------------

    for (const camera of cameras) {
      const id = getCameraId(camera);

      if (id === undefined || id === null) {
        continue;
      }

      const config = parseConfig(camera);

      const sourceType = getCameraSourceType(config);

      const signature = getCameraConfigSignature(config);

      const existingWorker = workers.get(id);

      if (existingWorker) {
        const configChanged = existingWorker.configSignature !== signature;

        const sourceChanged = existingWorker.sourceType !== sourceType;

        existingWorker.camera = config;

        if (configChanged || sourceChanged) {
          console.log(`[CAMERA ${id}] CONFIG CHANGED - RESTART WORKER`);

          stopWorker(existingWorker);

          existingWorker.stopping = false;
          existingWorker.unsupported = false;
          existingWorker.sourceError = null;

          existingWorker.sourceType = sourceType;
          existingWorker.configSignature = signature;

          startWorker(existingWorker);
        } else if (
          !existingWorker.process &&
          !existingWorker.stopping &&
          !existingWorker.unsupported
        ) {
          startWorker(existingWorker);
        }

        continue;
      }

      const worker = createWorker(config);

      workers.set(id, worker);

      startWorker(worker);
    }
  } catch (error) {
    console.error("[CAMERA SYNC ERROR]:", safeError(error));
  } finally {
    syncing = false;
  }
}

// ======================================================
// SERVICE START / STOP
// ======================================================

async function startCameraStreamService() {
  if (serviceStarted) return;

  serviceStarted = true;

  console.log("[CAMERA SERVICE] STARTING...");

  await syncCameras();

  if (syncTimer) {
    clearInterval(syncTimer);
  }

  syncTimer = setInterval(() => {
    syncCameras().catch((error) => {
      console.error("[CAMERA SERVICE] SYNC ERROR:", safeError(error));
    });
  }, SYNC_INTERVAL);

  if (syncTimer.unref) {
    syncTimer.unref();
  }

  console.log("[CAMERA SERVICE] STARTED");
}

async function stopCameraStreamService() {
  serviceStarted = false;

  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  for (const worker of workers.values()) {
    stopWorker(worker);
  }

  workers.clear();

  console.log("[CAMERA SERVICE] STOPPED");
}

// ======================================================
// LIVE STATUS
// ======================================================

function getCameraStreamStatus() {
  return [...workers.entries()].map(([id, worker]) => {
    const tracks = [...worker.tracks.values()];

    const now = Date.now();

    return {
      last_ffmpeg_exit: worker.lastFfmpegExit,

      ffmpeg_pid: worker.process?.pid || null,

      ffmpeg_started_at: worker.processStartedAt
        ? new Date(worker.processStartedAt).toISOString()
        : null,

      restart_attempts: worker.restartAttempts,

      restart_pending: Boolean(worker.restartTimer),

      ffmpeg_stderr: worker.stderrTail || null,

      camera_id: id,

      camera_name:
        worker.camera.camera_name || worker.camera.name || `Camera ${id}`,

      protocol: worker.camera.protocol || null,

      source_type: worker.sourceType,

      unsupported: worker.unsupported,

      source_error: worker.sourceError,

      connected: worker.connected,

      processing: worker.processing,

      running: Boolean(
        worker.process &&
        worker.process.exitCode === null &&
        !worker.process.killed,
      ),

      latest_frame_at: worker.latestFrameAt
        ? new Date(worker.latestFrameAt).toISOString()
        : null,

      frame_available: Boolean(worker.latestFrame),

      frame_age_ms: worker.latestFrameAt ? now - worker.latestFrameAt : null,

      person_present: tracks.length > 0,

      person_count: tracks.length,

      known_count: tracks.filter((track) => track.status === "known").length,

      unknown_count: tracks.filter((track) =>
        ["unknown", "uncertain"].includes(track.status),
      ).length,

      image_width: worker.imageWidth,

      image_height: worker.imageHeight,

      last_ai_error: worker.lastAiError,

      tracks: tracks.map(serializeTrack),
    };
  });
}

// ======================================================
// LATEST LIVE SNAPSHOT - FRAME + TRACKS
// ======================================================

function getCameraLiveSnapshot(cameraId) {
  const numericId = Number(cameraId);

  const key = Number.isNaN(numericId) ? cameraId : numericId;

  const worker = workers.get(key);

  if (!worker || !worker.latestSnapshot) {
    return null;
  }

  const snapshot = worker.latestSnapshot;

  return {
    frameId: snapshot.frameId,
    capturedAt: snapshot.capturedAt,
    processedAt: snapshot.processedAt,

    imageWidth: snapshot.imageWidth,
    imageHeight: snapshot.imageHeight,

    personCount: snapshot.personCount,
    tracks: snapshot.tracks,

    // Trả Buffer để controller tự quyết định cách truyền.
    frame: snapshot.frame,
  };
}

// ======================================================
// LATEST FRAME
// ======================================================

function getCameraLatestFrame(cameraId) {
  const numericId = Number(cameraId);

  const key = Number.isNaN(numericId) ? cameraId : numericId;

  const worker = workers.get(key);

  if (!worker || !worker.latestFrame) {
    return null;
  }

  return {
    frame: worker.latestFrame,
    capturedAt: worker.latestFrameAt,
    imageWidth: worker.imageWidth,
    imageHeight: worker.imageHeight,
  };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  startCameraStreamService,
  stopCameraStreamService,

  syncCameras,

  getCameraStreamStatus,
  getCameraLatestFrame,
  getCameraLiveSnapshot,
};
