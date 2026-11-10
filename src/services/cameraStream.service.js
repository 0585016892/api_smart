const { spawn } = require("child_process");
const { pool } = require("../config/database");
const { matchFace } = require("./faceRecognition.service");
const { recordRecognitionEvent } = require("./recognitionEvent.service");

const ffmpeg = require("ffmpeg-static");

const SYNC_INTERVAL = 5000;
const RECONNECT_DELAY = 10000;
const EVENT_COOLDOWN = Math.max(
  Number(process.env.FACE_EVENT_COOLDOWN_MS || 60000),
  10000,
);
const UNKNOWN_COOLDOWN = Math.max(
  Number(process.env.FACE_UNKNOWN_COOLDOWN_MS || 120000),
  10000,
);
const FRAME_INTERVAL = Math.max(
  Number(process.env.CAMERA_FRAME_INTERVAL_SECONDS || 2),
  1,
);

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
  return String(error || "Lỗi kết nối RTSP")
    .replace(/rtsp:\/\/[^\s]+/gi, "rtsp://[đã ẩn]")
    .slice(0, 1000);
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
      err.message,
    );
  }
}

/**
 * Tách JPEG từ luồng image2pipe.
 */
function extractJpegs(buffer) {
  const frames = [];
  let remaining = buffer;

  while (remaining.length >= 4) {
    const start = remaining.indexOf(Buffer.from([0xff, 0xd8]));

    if (start === -1) {
      remaining = remaining.slice(Math.max(0, remaining.length - 1));
      break;
    }

    const end = remaining.indexOf(Buffer.from([0xff, 0xd9]), start + 2);

    if (end === -1) {
      remaining = remaining.slice(start);
      break;
    }

    frames.push(remaining.slice(start, end + 2));
    remaining = remaining.slice(end + 2);
  }

  return { frames, remaining };
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

async function processFrame(worker, imageBuffer) {
  if (worker.processing || worker.stopping) return;

  worker.processing = true;

  try {
    const result = await matchFace(imageBuffer);

    const identity = getEventIdentity(result);
    const eventKey = `${worker.id}:${identity}`;
    const now = Date.now();

    const cooldown =
      result.status === "unknown" ? UNKNOWN_COOLDOWN : EVENT_COOLDOWN;

    const lastTime = lastEvents.get(eventKey) || 0;

    if (now - lastTime < cooldown) {
      return;
    }

    // Đánh dấu trước khi lưu để tránh hai frame đồng thời ghi trùng.
    lastEvents.set(eventKey, now);

    try {
      const history = await recordRecognitionEvent({
        imageBuffer,
        result,
        cameraId: worker.id,
      });

      console.log(
        `[CAMERA ${worker.id}] ${result.status.toUpperCase()}:`,
        result.person?.full_name || result.message,
        `(${result.similarity})`,
      );

      return history;
    } catch (error) {
      // Cho phép thử lại nếu lưu sự kiện thất bại.
      lastEvents.delete(eventKey);
      throw error;
    }
  } catch (error) {
    const message = String(error.message || "");

    // Không ghi log liên tục khi frame không có khuôn mặt.
    if (
      !message.toLowerCase().includes("no face") &&
      !message.toLowerCase().includes("không phát hiện") &&
      !message.toLowerCase().includes("không tìm thấy khuôn mặt")
    ) {
      console.error(
        `[CAMERA ${worker.id}] Lỗi xử lý frame:`,
        safeError(message),
      );
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
    rtspUrl = buildRtspUrl(config);
  } catch (error) {
    updateCameraStatus(id, "error", safeError(error.message));
    console.error(`[CAMERA ${id}]`, error.message);
    return;
  }

  const worker = {
    id,
    process: null,
    buffer: Buffer.alloc(0),
    processing: false,
    connected: false,
    stopping: false,
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

  const child = spawn(ffmpeg, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.process = child;

  let stderr = "";

  child.stdout.on("data", async (chunk) => {
    if (worker.stopping) return;

    worker.buffer = Buffer.concat([worker.buffer, chunk]);

    const parsed = extractJpegs(worker.buffer);
    worker.buffer = parsed.remaining;

    // Chống bộ nhớ tăng không giới hạn nếu luồng lỗi.
    if (worker.buffer.length > 10 * 1024 * 1024) {
      worker.buffer = Buffer.alloc(0);
    }

    for (const frame of parsed.frames) {
      if (!worker.connected) {
        worker.connected = true;

        await updateCameraStatus(id, "active");

        console.log(`[CAMERA ${id}] RTSP CONNECTED`);
      }

      // Bỏ frame mới nếu AI vẫn đang xử lý frame trước.
      if (!worker.processing) {
        processFrame(worker, frame);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();

    if (stderr.length > 3000) {
      stderr = stderr.slice(-3000);
    }
  });

  child.on("error", (error) => {
    console.error(
      `[CAMERA ${id}] Không chạy được FFmpeg:`,
      safeError(error.message),
    );
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
  const worker = workers.get(Number(id));

  if (!worker) {
    await updateCameraStatus(id, "inactive");
    return;
  }

  worker.stopping = true;
  workers.delete(Number(id));

  try {
    if (worker.process && !worker.process.killed) {
      worker.process.kill();
    }
  } catch (error) {
    console.error(`[CAMERA ${id}] Không dừng được FFmpeg:`, error.message);
  }

  await updateCameraStatus(id, "inactive");
  console.log(`[CAMERA ${id}] Đã dừng`);
}

/**
 * Đồng bộ camera từ MySQL:
 * - Tự chạy camera RTSP đang bật.
 * - Tự dừng camera bị tắt.
 * - Tự khởi động lại nếu cấu hình thay đổi hoặc tiến trình chết.
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

    const enabledIds = new Set(cameras.map((item) => Number(item.id)));

    for (const [id] of workers) {
      if (!enabledIds.has(id)) {
        await stopWorker(id);
      }
    }

    for (const camera of cameras) {
      const id = Number(camera.id);
      const currentConfig = parseConfig(camera.connection_config);
      const signature = JSON.stringify({
        protocol: camera.protocol,
        config: currentConfig,
      });

      const existing = workers.get(id);

      if (existing && existing.signature === signature) {
        continue;
      }

      if (existing) {
        await stopWorker(id);
      }

      startWorker(camera);
    }
  } catch (error) {
    console.error("[CAMERA STREAM] Sync error:", error.message);
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
    running: Boolean(worker.process && !worker.process.killed),
  }));
}

module.exports = {
  startCameraStreamService,
  stopCameraStreamService,
  getCameraStreamStatus,
};
