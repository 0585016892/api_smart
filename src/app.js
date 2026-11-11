const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");

const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const healthRoutes = require("./routes/health.routes");
const authRoutes = require("./routes/auth.routes");
const personRoutes = require("./routes/person.routes");
const faceProfileRoutes = require("./routes/faceProfile.routes");
const faceRecognitionRoutes = require("./routes/faceRecognition.routes");
const recognitionHistoryRoutes = require("./routes/recognitionHistory.routes");
const recognitionStatsRoutes = require("./routes/recognitionStats.routes");
const telegramRoutes = require("./routes/telegram.routes");
const telegramLinkRoutes = require("./routes/telegramLink.routes");
const cameraRoutes = require("./routes/camera.routes");
const recognitionSessionRoutes = require("./routes/recognitionSession.routes");
const userRoutes = require("./routes/user.routes");
const auditLogRoutes = require("./routes/auditLog.routes");
const systemSettingRoutes = require("./routes/systemSetting.routes");
const notificationHistoryRoutes = require("./routes/notificationHistory.routes");

const app = express();
// Cloudflare Tunnel chạy trên cùng máy chủ
app.set("trust proxy", "loopback");
// ==========================================
// SECURITY
// ==========================================

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },
  }),
);

app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? (process.env.CORS_ORIGINS || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : true,
    credentials: true,
  }),
);

// ==========================================
// REQUEST PARSER
// ==========================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ==========================================
// LOGGER
// ==========================================

app.use(morgan("dev"));

// ==========================================
// STATIC FILES
// ==========================================

// Dự kiến cấu trúc:
// backend/
//   app.js
//   uploads/
//     faces/
//       person_2/
//         image.png

const uploadsDirectory = path.resolve(__dirname, "..", "uploads");
const facesDirectory = path.join(uploadsDirectory, "faces");

console.log("\n========== STATIC FILE CONFIG ==========");
console.log("APP DIRECTORY:", __dirname);
console.log("UPLOADS DIRECTORY:", uploadsDirectory);
console.log("UPLOADS EXISTS:", fs.existsSync(uploadsDirectory));
console.log("FACES DIRECTORY:", facesDirectory);
console.log("FACES EXISTS:", fs.existsSync(facesDirectory));
console.log("========================================\n");

// Tạo thư mục nếu chưa tồn tại
if (!fs.existsSync(facesDirectory)) {
  fs.mkdirSync(facesDirectory, { recursive: true });
  console.log("Created faces directory:", facesDirectory);
}

// URL:
// http://localhost:12005/faces/person_2/image.png
//
// File thực tế:
// uploads/faces/person_2/image.png

app.use(
  "/faces",
  express.static(facesDirectory, {
    fallthrough: true,
    index: false,
    maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  }),
);

// Nếu hệ thống có thư mục uploads khác cần truy cập qua URL /uploads
app.use(
  "/uploads",
  express.static(uploadsDirectory, {
    fallthrough: true,
    index: false,
    maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
  }),
);

// ==========================================
// API INFORMATION
// ==========================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Smart Face Security",
    version: "1.0.0",
    description: "Face Recognition & Camera Monitoring System",
  });
});

// ==========================================
// API ROUTES
// ==========================================

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);

app.use("/api/persons", personRoutes);
app.use("/api/persons", faceProfileRoutes);

app.use("/api/recognition", faceRecognitionRoutes);
app.use("/api/recognition-history", recognitionHistoryRoutes);
app.use("/api/recognition/stats", recognitionStatsRoutes);

app.use("/api/telegram", telegramRoutes);
app.use("/api/telegram", telegramLinkRoutes);

app.use("/api/cameras", cameraRoutes);

app.use("/api/recognition/sessions", recognitionSessionRoutes);

app.use("/api/users", userRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/system-settings", systemSettingRoutes);
app.use("/api/notifications", notificationHistoryRoutes);

// ==========================================
// 404 HANDLER
// ==========================================

app.use(notFoundHandler);

// ==========================================
// ERROR HANDLER
// ==========================================

app.use(errorHandler);

module.exports = app;
