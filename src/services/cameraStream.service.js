const { spawn } = require("child_process");
const { pool } = require("../config/database");
const { matchFace } = require("./faceRecognition.service");
const { recordRecognitionEvent } = require("./recognitionEvent.service");
const ffmpeg = require("ffmpeg-static");

const SYNC_INTERVAL = 5000;

const FRAME_INTERVAL = Math.max(
  Number(process.env.CAMERA_FRAME_INTERVAL_SECONDS || 2),
  1,
);

// Camera phải không phát hiện người liên tục đủ thời gian mới kết thúc lượt.
const PRESENCE_EXIT_GRACE_MS = Math.max(
  Number(process.env.CAMERA_PRESENCE_EXIT_SECONDS || 10) * 1000,
  5000,
);

const ERROR_LOG_INTERVAL = 30000;
const MAX_BUFFER_SIZE = 15 * 1024 * 1024;

const workers = new Map();

let syncTimer = null;
let syncing = false;
let stopping = false;

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

async function updateCameraStatus(id, status, error = null) {
  try {
    if (status === "active") {
      await pool.execute(
        `UPDATE cameras
         SET status = 'active',
             last_connected_at = NOW(),
             last_error = NULL
         WHERE id = ?`,
        [id],
      );

      return;
    }

    await pool.execute(
      `UPDATE cameras
       SET status = ?, last_error = ?
       WHERE id = ?`,
      [status, error, id],
    );
  } catch (err) {
    console.error(
      `[CAMERA ${id}] Không cập nhật được trạng thái:`,
      getErrorMessage(err),
    );
  }
}

/**
 * Tách các frame JPEG từ image2pipe.
 */
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

  return {
    frames,
    remaining,
  };
}

function logFrameError(worker, error) {
  const now = Date.now();

  if (now - worker.lastErrorLogAt < ERROR_LOG_INTERVAL) return;

  worker.lastErrorLogAt = now;

  const stack = error?.stack || error?.message || error;

  console.error(`[CAMERA ${worker.id}] Lỗi xử lý frame:\n`, safeError(stack));
}

function logFrameStatus(worker, message) {
  const now = Date.now();

  if (now - (worker.lastStatusLogAt || 0) < 10000) return;

  worker.lastStatusLogAt = now;

  console.log(
    `[CAMERA ${worker.id}] ${message} | ` +
      `Frames: ${worker.framesReceived || 0} | ` +
      `AI processed: ${worker.framesProcessed || 0}`,
  );
}

/**
 * Đóng một lượt xuất hiện khi camera không còn phát hiện người.
 */
function updatePersonAbsence(worker) {
  if (!worker.presenceActive || !worker.lastPersonSeenAt) {
    return;
  }

  const now = Date.now();
  const absentDuration = now - worker.lastPersonSeenAt;

  if (absentDuration < PRESENCE_EXIT_GRACE_MS) {
    return;
  }

  worker.presenceActive = false;
  worker.presenceEventSaved = false;
  worker.lastPersonSeenAt = 0;

  console.log(
    `[CAMERA ${worker.id}] Người đã rời khỏi camera. ` +
      `Đã kết thúc lượt xuất hiện.`,
  );
}

/**
 * Xử lý một frame:
 * - Không có người: cập nhật thời gian vắng mặt.
 * - Có người: mở hoặc duy trì lượt xuất hiện.
 * - Mỗi lượt chỉ ghi một sự kiện.
 */
async function processFrame(worker, imageBuffer) {
  if (worker.processing || worker.stopping || stopping) {
    return;
  }

  worker.processing = true;
  worker.framesProcessed = (worker.framesProcessed || 0) + 1;

  try {
    const result = await matchFace(imageBuffer);

    if (!result || !result.status) {
      throw new Error("Face AI không trả về kết quả hợp lệ");
    }

    if (worker.stopping || stopping) return;

    const now = Date.now();

    // Không phát hiện người trong frame.
    if (result.status === "no_person" || !result.personDetected) {
      updatePersonAbsence(worker);

      logFrameStatus(
        worker,
        worker.presenceActive
          ? "Không phát hiện người trong frame, đang chờ xác nhận rời đi"
          : "Đang hoạt động, chưa phát hiện người",
      );

      return;
    }

    // Có người: cập nhật thời điểm nhìn thấy gần nhất.
    worker.lastPersonSeenAt = now;

    // Mở lượt xuất hiện mới.
    if (!worker.presenceActive) {
      worker.presenceActive = true;
      worker.presenceEventSaved = false;

      console.log(
        `[CAMERA ${worker.id}] PHÁT HIỆN NGƯỜI - BẮT ĐẦU LƯỢT XUẤT HIỆN`,
      );
    }

    logFrameStatus(
      worker,
      `AI RESULT: ${String(result.status).toUpperCase()} - ` +
        `${result.person?.full_name || result.message || "Chưa xác định danh tính"}`,
    );

    // Đã ghi sự kiện cho lượt xuất hiện hiện tại thì không ghi lại.
    if (worker.presenceEventSaved) {
      return;
    }

    // Đánh dấu sau khi lưu thành công.
    // Nếu DB lỗi, frame kế tiếp vẫn có thể thử ghi lại.
    await recordRecognitionEvent({
      imageBuffer,
      result,
      cameraId: worker.id,
    });

    worker.presenceEventSaved = true;

    console.log(
      `[CAMERA ${worker.id}] EVENT SAVED:`,
      String(result.status).toUpperCase(),
      result.person?.full_name || result.message || "Không xác định",
      result.similarity != null ? `(${result.similarity})` : "",
      `| Face count: ${result.faceCount || 0}`,
    );
  } catch (error) {
    logFrameError(worker, error);
  } finally {
    worker.processing = false;
  }
}

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

    lastErrorLogAt: 0,
    lastStatusLogAt: 0,

    framesReceived: 0,
    framesProcessed: 0,

    // Trạng thái chống gửi sự kiện liên tục.
    presenceActive: false,
    presenceEventSaved: false,
    lastPersonSeenAt: 0,

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
    `fps=1/${FRAME_INTERVAL}`,

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

        console.error(
          `[CAMERA ${id}] Buffer vượt giới hạn, đã giải phóng bộ nhớ`,
        );
      }

      for (const frame of parsed.frames) {
        if (worker.stopping || stopping) break;

        worker.framesReceived++;

        if (!worker.connected) {
          worker.connected = true;

          await updateCameraStatus(id, "active");

          console.log(`[CAMERA ${id}] RTSP CONNECTED`);
        }

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

    if (worker.stopping || stopping) {
      await updateCameraStatus(id, "inactive");
      return;
    }

    const detail = safeError(stderr.trim() || `FFmpeg kết thúc với mã ${code}`);

    await updateCameraStatus(id, "error", detail);

    console.error(`[CAMERA ${id}] RTSP DISCONNECTED:`, detail);
  });
}

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

/**
 * Đồng bộ camera từ MySQL.
 */
async function syncCameras() {
  if (syncing || stopping) return;

  syncing = true;

  try {
    const [cameras] = await pool.query(`
      SELECT
        id,
        protocol,
        connection_config,
        is_enabled
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

function getCameraStreamStatus() {
  return [...workers.entries()].map(([id, worker]) => ({
    camera_id: id,
    connected: worker.connected,
    processing: worker.processing,
    running: Boolean(worker.process && worker.process.exitCode === null),
    person_present: worker.presenceActive,
    event_saved: worker.presenceEventSaved,
    last_person_seen_at: worker.lastPersonSeenAt
      ? new Date(worker.lastPersonSeenAt).toISOString()
      : null,
  }));
}

module.exports = {
  startCameraStreamService,
  stopCameraStreamService,
  getCameraStreamStatus,
};
