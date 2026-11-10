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

const EVENT_COOLDOWN = Math.max(
  Number(process.env.FACE_EVENT_COOLDOWN_MS || 60000),
  10000,
);

const UNKNOWN_COOLDOWN = Math.max(
  Number(process.env.FACE_UNKNOWN_COOLDOWN_MS || 120000),
  10000,
);

const ERROR_LOG_INTERVAL = 30000;
const MAX_BUFFER_SIZE = 15 * 1024 * 1024;

const workers = new Map();
const lastEvents = new Map();

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

  if (config.username) {
    url.username = config.username;
  }

  if (config.password) {
    url.password = config.password;
  }

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
 * Tách các frame JPEG từ luồng image2pipe.
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

    if (end === -1) {
      break;
    }

    frames.push(remaining.subarray(0, end + 2));
    remaining = remaining.subarray(end + 2);
  }

  return {
    frames,
    remaining,
  };
}

function getEventIdentity(result) {
  if (result.status === "known" && result.person?.id) {
    return `known:${result.person.id}`;
  }

  if (result.status === "uncertain") {
    const candidate = result.candidates?.[0];

    return `uncertain:${candidate?.person_id || "unknown"}`;
  }

  return "unknown";
}

function logFrameError(worker, error) {
  const now = Date.now();

  if (now - worker.lastErrorLogAt < ERROR_LOG_INTERVAL) {
    return;
  }

  worker.lastErrorLogAt = now;

  // Ghi stack đầy đủ để tìm đúng package gây lỗi.
  // Không ghi URL RTSP hoặc thông tin đăng nhập.
  const stack = error?.stack || error?.message || error;

  console.error(`[CAMERA ${worker.id}] Lỗi xử lý frame:\n`, safeError(stack));
}

async function processFrame(worker, imageBuffer) {
  if (worker.processing || worker.stopping || stopping) {
    return;
  }

  worker.processing = true;

  try {
    const result = await matchFace(imageBuffer);

    if (!result || !result.status) {
      throw new Error("Face AI không trả về kết quả hợp lệ");
    }

    if (worker.stopping || stopping) {
      return;
    }

    const identity = getEventIdentity(result);
    const eventKey = `${worker.id}:${identity}`;
    const now = Date.now();

    const cooldown =
      result.status === "unknown" ? UNKNOWN_COOLDOWN : EVENT_COOLDOWN;

    const lastTime = lastEvents.get(eventKey) || 0;

    if (now - lastTime < cooldown) {
      return;
    }

    // Đánh dấu trước khi ghi DB để tránh ghi trùng.
    lastEvents.set(eventKey, now);

    try {
      await recordRecognitionEvent({
        imageBuffer,
        result,
        cameraId: worker.id,
      });

      console.log(
        `[CAMERA ${worker.id}] ${String(result.status).toUpperCase()}:`,
        result.person?.full_name || result.message || "Không xác định",
        result.similarity != null ? `(${result.similarity})` : "",
      );
    } catch (error) {
      // Nếu ghi DB thất bại, cho phép thử lại.
      lastEvents.delete(eventKey);
      throw error;
    }
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();

    // Không log liên tục nếu không có khuôn mặt.
    const isNormalNoFace =
      message.includes("no face") ||
      message.includes("không phát hiện") ||
      message.includes("không tìm thấy khuôn mặt") ||
      message.includes("no valid face");

    if (!isNormalNoFace) {
      logFrameError(worker, error);
    }
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

    // Timeout RTSP, đơn vị micro giây.
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

        if (!worker.connected) {
          worker.connected = true;

          await updateCameraStatus(id, "active");

          console.log(`[CAMERA ${id}] RTSP CONNECTED`);
        }

        // Mỗi camera chỉ xử lý một frame tại một thời điểm.
        if (!worker.processing) {
          processFrame(worker, frame);
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

    // Worker sẽ được syncCameras khởi động lại.
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
 *
 * - Tự chạy camera RTSP đang bật.
 * - Tự dừng camera bị tắt.
 * - Tự khởi động lại nếu cấu hình thay đổi.
 * - Tự khởi động lại khi FFmpeg bị chết.
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

    // Dừng worker không còn được bật.
    for (const [id] of workers) {
      if (!enabledIds.has(id)) {
        await stopWorker(id);
      }
    }

    // Khởi động hoặc cập nhật worker.
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

    // Xóa lịch sử cooldown cũ để tránh Map tăng mãi.
    const now = Date.now();

    for (const [key, timestamp] of lastEvents) {
      if (now - timestamp > 24 * 60 * 60 * 1000) {
        lastEvents.delete(key);
      }
    }
  } catch (error) {
    console.error("[CAMERA STREAM] Sync error:", getErrorMessage(error));
  } finally {
    syncing = false;
  }
}

function startCameraStreamService() {
  if (syncTimer) return;

  stopping = false;

  console.log("[CAMERA STREAM] Service starting...");

  syncCameras();

  syncTimer = setInterval(syncCameras, SYNC_INTERVAL);
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
  }));
}

module.exports = {
  startCameraStreamService,
  stopCameraStreamService,
  getCameraStreamStatus,
};
