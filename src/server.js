require("dotenv").config();

const app = require("./app");
const { testConnection } = require("./config/database");
const telegramBotService = require("./services/telegramBot.service");
const cameraStreamService = require("./services/cameraStream.service");

const PORT = process.env.PORT || 12005;
const path = require("path");
const express = require("express");

app.use("/faces", express.static(path.join(__dirname, "uploads", "faces")));

let shuttingDown = false;

const startServer = async () => {
  try {
    // 1. Kiểm tra MySQL.
    await testConnection();

    // 2. Khởi động Telegram.
    telegramBotService.startTelegramBot();

    // 3. Khởi động HTTP API.
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log("");
      console.log("====================================");
      console.log(" SMART FACE SECURITY");
      console.log("====================================");
      console.log(` API: http://localhost:${PORT}`);
      console.log(` Health: http://localhost:${PORT}/api/health`);
      console.log(" Status: RUNNING");
      console.log("====================================");
      console.log("");
    });

    // 4. Khởi động quản lý camera RTSP.
    cameraStreamService.startCameraStreamService();

    const shutdown = async (signal) => {
      if (shuttingDown) return;

      shuttingDown = true;

      console.log(`[SERVER] Received ${signal}, shutting down...`);

      try {
        // Dừng camera và tiến trình FFmpeg trước.
        await cameraStreamService.stopCameraStreamService();

        // Dừng Telegram.
        telegramBotService.stopTelegramBot();

        // Đóng HTTP server.
        server.close(() => {
          console.log("[SERVER] HTTP server closed");
          process.exit(0);
        });

        // Không để server treo vô thời hạn.
        setTimeout(() => {
          console.error("[SERVER] Shutdown timeout");
          process.exit(1);
        }, 15000).unref();
      } catch (error) {
        console.error("[SERVER] Shutdown error:", error);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    console.error("SERVER START ERROR:", error);
    process.exit(1);
  }
};

startServer();
