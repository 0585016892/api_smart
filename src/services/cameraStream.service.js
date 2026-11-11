const { spawn } = require("child_process");
const { pool } = require("../config/database");
const { matchFace } = require("./faceRecognition.service");
const { recordRecognitionEvent } = require("./recognitionEvent.service");
const ffmpeg = require("ffmpeg-static");

// =========================================================
// CONFIG
// =========================================================

const SYNC_INTERVAL = 5000;

// Tần suất FFmpeg xuất frame để phục vụ cả AI và giám sát trực tiếp.
// Mặc định 5 FPS để hình ảnh trên frontend không bị giật quá nhiều.
const CAMERA_STREAM_FPS = Math.max(
  Number(process.env.CAMERA_STREAM_FPS || 5),
  1,
);

const PRESENCE_EXIT_GRACE_MS = Math.max(
  Number(process.env.CAMERA_PRESENCE_EXIT_SECONDS || 10) * 1000,
  5000,
);

const ERROR_LOG_INTERVAL = 30000;
const MAX_BUFFER_SIZE = 15 * 1024 * 1024;

const TRACK_IOU_THRESHOLD = 0.12;
const TRACK_DISTANCE_RATIO = 0.65;

const workers = new Map();

let syncTimer = null;
let syncing = false;
let stopping = false;

let globalTrackCounter = 0;

// =========================================================
// CONFIG HELPERS
// =========================================================

function parseConfig(value) {
  if (!value) return {};

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  return value;
}

function buildRtspUrl(config) {
  const rawUrl = config.rtsp_url || config.url;

  if (rawUrl) {
    const url = new URL(rawUrl);

    if (url.protocol !== "rtsp:") {
      throw new Error("Giao thức camera không phải RTSP");
    }

    return url.toString();
  }

  if (!config.host) {
    throw new Error("Camera chưa cấu hình địa chỉ host");
  }

  const url = new URL(
    `rtsp://${config.host}:${Number(config.port || 554)}${config.stream_path || "/"}`,
  );

  if (config.username) url.username = config.username;
  if (config.password) url.password = config.password;

  return url.toString();
}

function safeError(error) {
  return String(error || "Lỗi không xác định")
    .replace(/rtsp:\/\/[^\s"'<>]+/gi, "rtsp://[đã ẩn]")
    .replace(/(password|passwd|pwd)=([^&\s]+)/gi, "$1=[đã ẩn]")
    .slice(0, 2000);
}

function getErrorMessage(error) {
  return safeError(error?.message || error || "Lỗi không xác định");
}

// =========================================================
// CAMERA STATUS
// =========================================================

async function updateCameraStatus(id, status, error = null) {
  try {
    if (status === "active") {
      await pool.execute(
        `
          UPDATE cameras
          SET status = 'active',
              last_connected_at = NOW(),
              last_error = NULL
          WHERE id = ?
        `,
        [id],
      );

      return;
    }

    await pool.execute(
      `
        UPDATE cameras
        SET status = ?, last_error = ?
        WHERE id = ?
      `,
      [status, error, id],
    );
  } catch (err) {
    console.error(
      `[CAMERA ${id}] Không cập nhật được trạng thái:`,
      getErrorMessage(err),
    );
  }
}

// =========================================================
// JPEG PARSER
// =========================================================

function extractJpegs(buffer) {
  const frames = [];
  let remaining = buffer;

  while (remaining.length >= 4) {
    const start = remaining.indexOf(Buffer.from([0xff, 0xd8]));

    if (start === -1) {
      remaining = remaining.slice(-1);
      break;
    }

    if (start > 0) {
      remaining = remaining.slice(start);
    }

    const end = remaining.indexOf(Buffer.from([0xff, 0xd9]), 2);

    if (end === -1) break;

    frames.push(remaining.subarray(0, end + 2));
    remaining = remaining.subarray(end + 2);
  }

  return { frames, remaining };
}

// =========================================================
// LOGGING
// =========================================================

function logFrameError(worker, error) {
  const now = Date.now();

  if (now - worker.lastErrorLogAt < ERROR_LOG_INTERVAL) return;

  worker.lastErrorLogAt = now;

  console.error(
    `[CAMERA ${worker.id}] Lỗi xử lý frame:\n`,
    safeError(error?.stack || error?.message || error),
  );
}

function logFrameStatus(worker, message) {
  const now = Date.now();

  if (now - (worker.lastStatusLogAt || 0) < 10000) return;

  worker.lastStatusLogAt = now;

  console.log(
    `[CAMERA ${worker.id}] ${message} | ` +
      `Frames: ${worker.framesReceived || 0} | ` +
      `AI processed: ${worker.framesProcessed || 0} | ` +
      `People: ${worker.tracks.size}`,
  );
}

// =========================================================
// BOX HELPERS
// =========================================================

function getBoxArea(box) {
  if (!box) return 0;

  return Math.max(0, box.width) * Math.max(0, box.height);
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
  const union = getBoxArea(a) + getBoxArea(b) - intersection;

  return union > 0 ? intersection / union : 0;
}

function calculateCenterDistance(a, b) {
  if (!a || !b) return Infinity;

  const dx = a.centerX - b.centerX;
  const dy = a.centerY - b.centerY;

  return Math.sqrt(dx * dx + dy * dy);
}

function canMatchTrack(track, detection) {
  const iou = calculateIoU(track.box, detection.box);

  if (iou >= TRACK_IOU_THRESHOLD) return true;

  const distance = calculateCenterDistance(track.box, detection.box);

  const diagonal = Math.sqrt(
    detection.box.width ** 2 + detection.box.height ** 2,
  );

  return distance <= diagonal * TRACK_DISTANCE_RATIO;
}

function isFaceInsideBody(faceBox, bodyBox) {
  if (!faceBox || !bodyBox) return false;

  return (
    faceBox.centerX >= bodyBox.left &&
    faceBox.centerX <= bodyBox.right &&
    faceBox.centerY >= bodyBox.top &&
    faceBox.centerY <= bodyBox.bottom
  );
}

function getFaceIndex(face, index) {
  if (face?.faceIndex != null) return face.faceIndex;
  if (face?.index != null) return face.index;

  return index;
}

// =========================================================
// BUILD PERSON DETECTIONS
// =========================================================

function buildPersonDetections(bodies, faceMatches) {
  const bodyList = Array.isArray(bodies) ? bodies : [];
  const faces = Array.isArray(faceMatches) ? faceMatches : [];

  const detections = bodyList
    .filter((body) => body?.box)
    .map((body) => ({
      ...body,
      detectionType: "body",
    }));

  const assignedFaces = new Set();
  const facesByBody = new Map();

  // Ghép khuôn mặt vào body phù hợp nhất.
  faces.forEach((face, facePosition) => {
    if (!face?.box) return;

    const candidates = bodyList
      .map((body, bodyIndex) => {
        if (!body?.box || !isFaceInsideBody(face.box, body.box)) {
          return null;
        }

        return {
          bodyIndex,
          area: getBoxArea(body.box),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.area - b.area);

    if (!candidates.length) return;

    const bodyIndex = candidates[0].bodyIndex;

    if (!facesByBody.has(bodyIndex)) {
      facesByBody.set(bodyIndex, []);
    }

    facesByBody.get(bodyIndex).push({
      face,
      facePosition,
    });
  });

  // Mỗi body chỉ đại diện một người.
  // Những khuôn mặt nằm trong body không tạo track độc lập.
  for (const matchedFaces of facesByBody.values()) {
    matchedFaces.sort(
      (a, b) =>
        (b.face.detectionScore || b.face.score || 0) -
        (a.face.detectionScore || a.face.score || 0),
    );

    for (const item of matchedFaces) {
      assignedFaces.add(item.facePosition);
    }
  }

  // Những khuôn mặt không thuộc body nào tạo detection riêng.
  faces.forEach((face, facePosition) => {
    if (!face?.box || assignedFaces.has(facePosition)) return;

    detections.push({
      box: face.box,
      score: face.detectionScore || face.score || 0,
      detectionType: "face",
      faceIndex: getFaceIndex(face, facePosition),
    });
  });

  return detections;
}

// =========================================================
// TRACK MANAGEMENT
// =========================================================

function createTrack(worker, detection, now) {
  globalTrackCounter += 1;

  const trackId = `CAM-${worker.id}-TRACK-${globalTrackCounter}`;

  const track = {
    id: trackId,
    box: detection.box,
    detectionType: detection.detectionType || "body",

    firstSeenAt: now,
    lastSeenAt: now,

    status: "pending",
    person: null,
    similarity: 0,

    faceDetected: false,
    faceScore: 0,

    eventSaved: false,
    notificationAttempted: false,
    eventId: null,

    latestFaceResult: null,
    missedFrames: 0,
  };

  worker.tracks.set(trackId, track);

  console.log(`[CAMERA ${worker.id}] TRACK CREATED: ${trackId}`);

  return track;
}

function updateTrack(track, detection, now) {
  track.box = detection.box;
  track.detectionType = detection.detectionType || track.detectionType;
  track.lastSeenAt = now;
  track.missedFrames = 0;
}

function matchBodyDetections(worker, detections, now) {
  const availableTracks = [...worker.tracks.values()];
  const pairs = [];

  for (const track of availableTracks) {
    for (let index = 0; index < detections.length; index++) {
      const detection = detections[index];

      if (!detection?.box) continue;

      if (!canMatchTrack(track, detection)) continue;

      const iou = calculateIoU(track.box, detection.box);
      const distance = calculateCenterDistance(track.box, detection.box);

      pairs.push({
        track,
        detection,
        index,
        iou,
        distance,
      });
    }
  }

  pairs.sort((a, b) => {
    if (b.iou !== a.iou) return b.iou - a.iou;

    return a.distance - b.distance;
  });

  const usedTracks = new Set();
  const usedDetections = new Set();
  const assignments = [];

  for (const pair of pairs) {
    if (usedTracks.has(pair.track.id)) continue;
    if (usedDetections.has(pair.index)) continue;

    usedTracks.add(pair.track.id);
    usedDetections.add(pair.index);

    updateTrack(pair.track, pair.detection, now);

    assignments.push({
      track: pair.track,
      detection: pair.detection,
    });
  }

  // Tạo track cho những detection chưa được ghép.
  for (let index = 0; index < detections.length; index++) {
    if (usedDetections.has(index)) continue;

    const detection = detections[index];

    if (!detection?.box) continue;

    const track = createTrack(worker, detection, now);

    usedTracks.add(track.id);

    assignments.push({
      track,
      detection,
    });
  }

  // Tăng missedFrames cho track không xuất hiện trong frame này.
  for (const track of worker.tracks.values()) {
    if (!usedTracks.has(track.id)) {
      track.missedFrames += 1;
    }
  }

  return assignments;
}

// =========================================================
// ASSIGN FACE TO TRACK
// =========================================================

function assignFacesToTracks(assignments, faceMatches) {
  const faces = Array.isArray(faceMatches) ? faceMatches : [];
  const usedFaces = new Set();

  for (const assignment of assignments) {
    const { track, detection } = assignment;

    const candidates = faces
      .map((face, index) => ({
        face,
        index,
        faceIndex: getFaceIndex(face, index),
      }))
      .filter(({ face, index, faceIndex }) => {
        if (!face?.box || usedFaces.has(faceIndex)) return false;

        if (detection.detectionType === "face" && detection.faceIndex != null) {
          return faceIndex === detection.faceIndex;
        }

        return isFaceInsideBody(face.box, detection.box);
      })
      .sort(
        (a, b) =>
          (b.face.detectionScore || b.face.score || 0) -
          (a.face.detectionScore || a.face.score || 0),
      );

    if (!candidates.length) continue;

    const selected = candidates[0];
    const face = selected.face;

    usedFaces.add(selected.faceIndex);

    track.faceDetected = true;
    track.faceScore = face.detectionScore || face.score || 0;

    if (face.status === "unverified") continue;

    track.status = face.status;
    track.person = face.person || null;
    track.similarity = face.similarity || 0;
    track.latestFaceResult = face;
  }
}

// =========================================================
// REMOVE EXPIRED TRACKS
// =========================================================

function removeExpiredTracks(worker, now) {
  for (const [trackId, track] of worker.tracks) {
    const absentDuration = now - track.lastSeenAt;

    if (absentDuration < PRESENCE_EXIT_GRACE_MS) continue;

    worker.tracks.delete(trackId);

    console.log(
      `[CAMERA ${worker.id}] TRACK CLOSED: ${trackId} | ` +
        `Status: ${track.status}`,
    );
  }
}

// =========================================================
// SAVE RECOGNITION EVENT
// =========================================================

async function saveTrackEvent(worker, track, imageBuffer) {
  if (track.eventSaved || !track.latestFaceResult) return;

  const result = {
    ...track.latestFaceResult,
    personDetected: true,
    faceDetected: true,
    faceCount: 1,
  };

  if (!["known", "unknown", "uncertain"].includes(result.status)) {
    return;
  }

  try {
    const history = await recordRecognitionEvent({
      imageBuffer,
      result,
      cameraId: worker.id,
      notifyTelegram: true,
    });

    track.eventSaved = true;
    track.notificationAttempted = true;
    track.eventId = history?.event?.id || null;

    console.log(
      `[CAMERA ${worker.id}] EVENT SAVED`,
      track.id,
      result.status,
      result.person?.full_name || "Người chưa xác định",
      result.similarity != null ? `(${result.similarity})` : "",
    );
  } catch (error) {
    console.error(
      `[CAMERA ${worker.id}] Không lưu được event ${track.id}:`,
      getErrorMessage(error),
    );
  }
}

// =========================================================
// PROCESS FRAME
// =========================================================

async function processFrame(worker, imageBuffer) {
  if (worker.processing || worker.stopping || stopping) return;

  worker.processing = true;
  worker.framesProcessed += 1;

  try {
    const result = await matchFace(imageBuffer);

    if (!result || typeof result.personDetected !== "boolean") {
      throw new Error("Face AI không trả về kết quả hợp lệ");
    }

    if (worker.stopping || stopping) return;

    const now = Date.now();

    // Xóa track hết thời gian vắng mặt trước khi ghép detection.
    removeExpiredTracks(worker, now);

    const bodies = result.bodies || [];
    const faceMatches = result.faceMatches || [];

    const detections = buildPersonDetections(bodies, faceMatches);

    console.log(
      `[CAMERA ${worker.id}] AI DETECTION | ` +
        `Bodies: ${bodies.length} | ` +
        `Faces: ${faceMatches.length} | ` +
        `Tracks: ${worker.tracks.size} | ` +
        `Detections: ${detections.length}`,
    );

    if (!detections.length) {
      logFrameStatus(
        worker,
        worker.tracks.size
          ? "Không thấy người trong frame, đang chờ xác nhận rời đi"
          : "Đang hoạt động, chưa phát hiện người",
      );

      return;
    }

    const assignments = matchBodyDetections(worker, detections, now);

    assignFacesToTracks(assignments, faceMatches);

    for (const { track } of assignments) {
      if (track.eventSaved || !track.latestFaceResult) continue;

      await saveTrackEvent(worker, track, imageBuffer);
    }

    removeExpiredTracks(worker, now);

    const knownCount = [...worker.tracks.values()].filter(
      (track) => track.status === "known",
    ).length;

    const unknownCount = [...worker.tracks.values()].filter((track) =>
      ["unknown", "uncertain"].includes(track.status),
    ).length;

    logFrameStatus(
      worker,
      `Đang theo dõi ${worker.tracks.size} người | ` +
        `Đã nhận diện: ${knownCount} | ` +
        `Người lạ/chưa xác định: ${unknownCount}`,
    );
  } catch (error) {
    logFrameError(worker, error);
  } finally {
    worker.processing = false;
  }
}

// =========================================================
// START CAMERA WORKER
// =========================================================

function startWorker(camera) {
  const id = Number(camera.id);
  const config = parseConfig(camera.connection_config);

  let rtspUrl;

  try {
    if (!ffmpeg) {
      throw new Error("Không tìm thấy FFmpeg từ package ffmpeg-static");
    }

    rtspUrl = buildRtspUrl(config);
  } catch (error) {
    updateCameraStatus(id, "error", getErrorMessage(error));
    console.error(`[CAMERA ${id}]`, getErrorMessage(error));
    return;
  }

  const worker = {
    id,
    process: null,
    buffer: Buffer.alloc(0),

    processing: false,
    connected: false,
    stopping: false,

    // Frame mới nhất phục vụ giám sát trực tiếp.
    latestFrame: null,
    latestFrameAt: null,

    lastErrorLogAt: 0,
    lastStatusLogAt: 0,

    framesReceived: 0,
    framesProcessed: 0,

    tracks: new Map(),

    signature: JSON.stringify({
      protocol: camera.protocol,
      config,
    }),
  };

  workers.set(id, worker);

  console.log(`[CAMERA ${id}] Đang khởi động RTSP...`);

  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-timeout",
    "10000000",
    "-i",
    rtspUrl,
    "-an",
    "-sn",
    "-dn",
    "-vf",
    `fps=${CAMERA_STREAM_FPS}`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "5",
    "pipe:1",
  ];

  let child;

  try {
    child = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    worker.process = child;
  } catch (error) {
    workers.delete(id);

    updateCameraStatus(id, "error", getErrorMessage(error));

    console.error(
      `[CAMERA ${id}] Không khởi chạy được FFmpeg:`,
      getErrorMessage(error),
    );

    return;
  }

  let stderr = "";

  child.stdout.on("data", async (chunk) => {
    if (worker.stopping || stopping) return;

    try {
      worker.buffer = Buffer.concat([worker.buffer, chunk]);

      const parsed = extractJpegs(worker.buffer);

      worker.buffer = parsed.remaining;

      if (worker.buffer.length > MAX_BUFFER_SIZE) {
        worker.buffer = Buffer.alloc(0);

        console.error(`[CAMERA ${id}] Buffer vượt giới hạn`);
      }

      for (const frame of parsed.frames) {
        if (worker.stopping || stopping) break;

        worker.framesReceived += 1;

        // Cập nhật frame mới nhất để frontend sử dụng.
        worker.latestFrame = Buffer.from(frame);
        worker.latestFrameAt = Date.now();

        if (!worker.connected) {
          worker.connected = true;

          await updateCameraStatus(id, "active");

          console.log(`[CAMERA ${id}] RTSP CONNECTED`);
        }

        // AI xử lý frame khi không bận.
        // Các frame mới vẫn được cập nhật cho live stream.
        if (!worker.processing) {
          processFrame(worker, frame);
        }

        if (worker.framesReceived === 1 || worker.framesReceived % 10 === 0) {
          logFrameStatus(
            worker,
            `Đã nhận frame JPEG (${(frame.length / 1024).toFixed(1)} KB)`,
          );
        }
      }
    } catch (error) {
      logFrameError(worker, error);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();

    if (stderr.length > 5000) {
      stderr = stderr.slice(-5000);
    }
  });

  child.on("error", async (error) => {
    const detail = getErrorMessage(error);

    console.error(`[CAMERA ${id}] FFmpeg process error:`, detail);

    await updateCameraStatus(id, "error", detail);
  });

  child.on("close", async (code) => {
    const isCurrentWorker = workers.get(id) === worker;

    if (isCurrentWorker) {
      workers.delete(id);
    }

    worker.connected = false;
    worker.latestFrame = null;
    worker.latestFrameAt = null;

    if (worker.stopping || stopping) {
      await updateCameraStatus(id, "inactive");
      return;
    }

    const detail = safeError(stderr.trim() || `FFmpeg kết thúc với mã ${code}`);

    await updateCameraStatus(id, "error", detail);

    console.error(`[CAMERA ${id}] RTSP DISCONNECTED:`, detail);
  });
}

// =========================================================
// STOP CAMERA WORKER
// =========================================================

async function stopWorker(id) {
  const cameraId = Number(id);
  const worker = workers.get(cameraId);

  if (!worker) {
    await updateCameraStatus(cameraId, "inactive");
    return;
  }

  worker.stopping = true;
  workers.delete(cameraId);

  try {
    if (
      worker.process &&
      worker.process.exitCode === null &&
      !worker.process.killed
    ) {
      worker.process.kill();
    }
  } catch (error) {
    console.error(
      `[CAMERA ${cameraId}] Không dừng được FFmpeg:`,
      getErrorMessage(error),
    );
  }

  await updateCameraStatus(cameraId, "inactive");

  console.log(`[CAMERA ${cameraId}] Đã dừng`);
}

// =========================================================
// SYNC CAMERAS
// =========================================================

async function syncCameras() {
  if (syncing || stopping) return;

  syncing = true;

  try {
    const [cameras] = await pool.query(`
      SELECT id, protocol, connection_config, is_enabled
      FROM cameras
      WHERE protocol = 'rtsp'
        AND is_enabled = 1
    `);

    const enabledIds = new Set(cameras.map((camera) => Number(camera.id)));

    for (const [id] of workers) {
      if (!enabledIds.has(id)) {
        await stopWorker(id);
      }
    }

    for (const camera of cameras) {
      const id = Number(camera.id);
      const config = parseConfig(camera.connection_config);

      const signature = JSON.stringify({
        protocol: camera.protocol,
        config,
      });

      const existing = workers.get(id);

      if (existing && existing.signature === signature) {
        continue;
      }

      if (existing) {
        await stopWorker(id);
      }

      if (!stopping) {
        startWorker(camera);
      }
    }
  } catch (error) {
    console.error("[CAMERA STREAM] Sync error:", getErrorMessage(error));
  } finally {
    syncing = false;
  }
}

// =========================================================
// START / STOP SERVICE
// =========================================================

async function startCameraStreamService() {
  if (syncTimer) return;

  stopping = false;

  console.log("[CAMERA STREAM] Service starting...");

  await syncCameras();

  if (stopping) return;

  syncTimer = setInterval(syncCameras, SYNC_INTERVAL);

  console.log("[CAMERA STREAM] Service started");
}

async function stopCameraStreamService() {
  stopping = true;

  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }

  const ids = [...workers.keys()];

  await Promise.all(ids.map((id) => stopWorker(id)));

  console.log("[CAMERA STREAM] Service stopped");
}

// =========================================================
// LIVE CAMERA STATUS
// =========================================================

function getCameraStreamStatus() {
  return [...workers.entries()].map(([id, worker]) => {
    const tracks = [...worker.tracks.values()];

    return {
      camera_id: id,

      connected: worker.connected,

      processing: worker.processing,

      running: Boolean(worker.process && worker.process.exitCode === null),

      latest_frame_at: worker.latestFrameAt
        ? new Date(worker.latestFrameAt).toISOString()
        : null,

      person_present: tracks.length > 0,
      person_count: tracks.length,

      known_count: tracks.filter((track) => track.status === "known").length,

      unknown_count: tracks.filter((track) =>
        ["unknown", "uncertain"].includes(track.status),
      ).length,

      tracks: tracks.map((track) => ({
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

        first_seen_at: new Date(track.firstSeenAt).toISOString(),

        last_seen_at: new Date(track.lastSeenAt).toISOString(),
      })),
    };
  });
}

// =========================================================
// GET LATEST CAMERA FRAME
// =========================================================

function getCameraLatestFrame(id) {
  const worker = workers.get(Number(id));

  if (!worker || !worker.connected || !worker.latestFrame) {
    return null;
  }

  return {
    frame: worker.latestFrame,
    capturedAt: worker.latestFrameAt,
  };
}

// =========================================================
// EXPORTS
// =========================================================

module.exports = {
  startCameraStreamService,
  stopCameraStreamService,

  getCameraStreamStatus,
  getCameraLatestFrame,
};
