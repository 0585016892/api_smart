// ======================================================
// FIX TENSORFLOW DLL PATH FOR WINDOWS
// ======================================================

const path = require("path");

if (process.platform === "win32") {
  const tensorflowLibPath = path.resolve(
    process.cwd(),
    "node_modules",
    "@tensorflow",
    "tfjs-node",
    "deps",
    "lib",
  );

  process.env.PATH = `${tensorflowLibPath};${process.env.PATH || ""}`;
}

require("dotenv").config();

const app = require("./app");
const { testConnection } = require("./config/database");
const telegramBotService = require("./services/telegramBot.service");
const cameraStreamService = require("./services/cameraStream.service");

const PORT = Number(process.env.PORT) || 12005;
const HOST = "0.0.0.0";

let server = null;
let shuttingDown = false;
let cameraStarted = false;
let telegramStarted = false;

const startHttpServer = () =>
  new Promise((resolve, reject) => {
    const httpServer = app.listen(PORT, HOST);

    httpServer.once("listening", () => resolve(httpServer));

    httpServer.once("error", (error) => {
      reject(error);
    });
  });

const shutdown = async (signal = "UNKNOWN", exitCode = 0) => {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`[SERVER] Received ${signal}, shutting down...`);

  try {
    if (cameraStarted) {
      await cameraStreamService.stopCameraStreamService();
      cameraStarted = false;
    }

    if (telegramStarted) {
      telegramBotService.stopTelegramBot();
      telegramStarted = false;
    }

    if (server) {
      await new Promise((resolve) => {
        server.close((error) => {
          if (error) {
            console.error("[SERVER] HTTP close error:", error.message);
          } else {
            console.log("[SERVER] HTTP server closed");
          }

          resolve();
        });
      });

      server = null;
    }

    process.exit(exitCode);
  } catch (error) {
    console.error("[SERVER] Shutdown error:", error);
    process.exit(1);
  }
};

const startServer = async () => {
  try {
    console.log("[SERVER] Starting Smart Face Security...");

    // 1. Kiểm tra MySQL
    await testConnection();

    // 2. Khởi động HTTP API
    server = await startHttpServer();

    console.log("");
    console.log("====================================");
    console.log(" SMART FACE SECURITY");
    console.log("====================================");
    console.log(` API: http://localhost:${PORT}`);
    console.log(` Health: http://localhost:${PORT}/api/health`);
    console.log(" Status: RUNNING");
    console.log("====================================");
    console.log("");

    // 3. Khởi động Telegram
    telegramBotService.startTelegramBot();
    telegramStarted = true;

    // 4. Khởi động camera
    cameraStarted = true;
    await cameraStreamService.startCameraStreamService();
  } catch (error) {
    console.error("[SERVER] START ERROR:", error);

    if (error.code === "EADDRINUSE") {
      console.error(`[SERVER] Port ${PORT} is already in use.`);
    }

    await shutdown("START_ERROR", 1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT", 0));
process.on("SIGTERM", () => shutdown("SIGTERM", 0));

process.on("uncaughtException", (error) => {
  console.error("[SERVER] Uncaught exception:", error);
  shutdown("UNCAUGHT_EXCEPTION", 1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[SERVER] Unhandled rejection:", reason);
  shutdown("UNHANDLED_REJECTION", 1);
});

// Chỉ tự khởi động khi chạy trực tiếp bằng Node/PM2.
if (require.main === module) {
  startServer();
}

module.exports = { startServer, shutdown };
