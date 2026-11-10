require("dotenv").config();

const app = require("./app");
const { testConnection } = require("./config/database");
const telegramBotService = require("./services/telegramBot.service");
const PORT = process.env.PORT || 12005;
const path = require("path");
const express = require("express");

app.use("/faces", express.static(path.join(__dirname, "uploads", "faces")));
const startServer = async () => {
  try {
    // Kiểm tra MySQL trước khi chạy server
    await testConnection();
    telegramBotService.startTelegramBot();
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

    const shutdown = (signal) => {
      console.log(`Received ${signal}, shutting down...`);
      telegramBotService.stopTelegramBot();
      server.close(() => {
        console.log("HTTP server closed");
        process.exit(0);
      });

      setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    console.error("SERVER START ERROR:", error);
    process.exit(1);
  }
};

startServer();
