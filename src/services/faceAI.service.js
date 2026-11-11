const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const tf = require("@tensorflow/tfjs-node");
const Human = require("@vladmandic/human").default;

let humanInstance = null;
let initializationPromise = null;
let lastDiagnosticLog = 0;

const MODEL_NAME = "vladmandic-human-3.3.6";
const DIAGNOSTIC_INTERVAL = 10000;

const modelDirectory = path.resolve(
  __dirname,
  "../../node_modules/@vladmandic/human/models",
);

// Tạo file URL chuẩn cho cả Windows và Linux.
const modelBasePath = `file://${modelDirectory.replace(/\\/g, "/")}/`;
const requiredModels = [
  "blazeface.json",
  "facemesh.json",
  "faceres.json",
  "movenet-lightning.json",
];

const humanConfig = {
  backend: "tensorflow",
  modelBasePath,
  debug: false,
  cacheModels: false,
  cacheSensitivity: 0,

  face: {
    enabled: true,

    detector: {
      rotation: false,
      maxDetected: 10,
      minConfidence: 0.3,
    },

    mesh: {
      enabled: true,
    },

    description: {
      enabled: true,
      minConfidence: 0.3,
    },
  },

  body: {
    enabled: true,
    maxDetected: 10,
    minConfidence: 0.3,
  },

  hand: {
    enabled: false,
  },

  object: {
    enabled: false,
  },

  gesture: {
    enabled: false,
  },
};

// ======================================================
// MODEL INITIALIZATION
// ======================================================

function checkModelFiles() {
  if (!fs.existsSync(modelDirectory)) {
    throw new Error(`Không tìm thấy thư mục model: ${modelDirectory}`);
  }

  const missingModels = requiredModels.filter(
    (filename) => !fs.existsSync(path.join(modelDirectory, filename)),
  );

  if (missingModels.length) {
    throw new Error(`Thiếu model AI: ${missingModels.join(", ")}`);
  }

  console.log("[FACE AI] MODEL DIRECTORY:", modelDirectory);
  console.log("[FACE AI] MODEL URL:", modelBasePath);
  console.log("[FACE AI] MODEL FILES: OK");
}

async function getHuman() {
  if (humanInstance) return humanInstance;

  if (!initializationPromise) {
    initializationPromise = (async () => {
      checkModelFiles();

      const human = new Human(humanConfig);

      await human.load();

      humanInstance = human;

      console.log("[FACE AI] Models loaded successfully");
      console.log("[FACE AI] VERSION:", human.version);
      console.log("[FACE AI] BACKEND:", human.tf?.getBackend?.());
      console.log(
        "[FACE AI] CONFIG:",
        JSON.stringify({
          faceEnabled: human.config.face.enabled,
          faceConfidence: human.config.face.detector.minConfidence,
          bodyEnabled: human.config.body.enabled,
          bodyConfidence: human.config.body.minConfidence,
          bodyMaxDetected: human.config.body.maxDetected,
          modelBasePath: human.config.modelBasePath,
        }),
      );

      return human;
    })().catch((error) => {
      humanInstance = null;
      initializationPromise = null;

      console.error("[FACE AI] INITIALIZATION ERROR:", error.message);

      throw error;
    });
  }

  return initializationPromise;
}

// ======================================================
// EMBEDDING
// ======================================================

function getEmbeddingArray(embedding) {
  if (Array.isArray(embedding)) {
    return embedding.map(Number);
  }

  if (ArrayBuffer.isView(embedding)) {
    return Array.from(embedding, Number);
  }

  return [];
}

function validateEmbedding(embedding) {
  const values = getEmbeddingArray(embedding);

  if (values.length < 64 || !values.every(Number.isFinite)) {
    return null;
  }

  return values;
}

// ======================================================
// BOUNDING BOX
// ======================================================

function normalizeBox(box) {
  if (!Array.isArray(box) || box.length < 4) {
    return null;
  }

  const values = box.slice(0, 4).map(Number);

  if (!values.every(Number.isFinite)) {
    return null;
  }

  const [x, y, width, height] = values;

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
}

// ======================================================
// DIAGNOSTICS
// ======================================================

function logDetectionDiagnostic({
  imageBuffer,
  width,
  height,
  result,
  bodies,
  faces,
}) {
  const now = Date.now();

  if (now - lastDiagnosticLog < DIAGNOSTIC_INTERVAL) {
    return;
  }

  lastDiagnosticLog = now;

  console.log("[FACE AI] FRAME DIAGNOSTIC", {
    imageBytes: imageBuffer.length,
    imageWidth: width,
    imageHeight: height,
    bodyCount: bodies.length,
    faceCount: faces.length,
    rawBodyCount: result.body?.length || 0,
    rawFaceCount: result.face?.length || 0,
    humanState: humanInstance?.state,
    backend: tf.getBackend(),
  });
}

// ======================================================
// ANALYZE FRAME
// ======================================================

async function analyzeFrame(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    throw new Error("Ảnh đầu vào không hợp lệ");
  }

  let decodedImage;
  let floatImage;
  let imageTensor;

  try {
    const human = await getHuman();

    decodedImage = tf.node.decodeImage(imageBuffer, 3);

    const [height, width] = decodedImage.shape;

    if (width < 80 || height < 80) {
      throw new Error(`Ảnh quá nhỏ: ${width}x${height}`);
    }

    if (width > 4096 || height > 4096) {
      throw new Error(`Kích thước ảnh vượt giới hạn: ${width}x${height}`);
    }

    floatImage = decodedImage.toFloat();
    imageTensor = floatImage.expandDims(0);

    const result = await human.detect(imageTensor);

    const rawBodies = result.body || [];
    const rawFaces = result.face || [];

    const bodies = rawBodies
      .map((body, index) => {
        const box = normalizeBox(body.box);

        if (!box) return null;

        return {
          index,
          box,
          score: Number(body.score ?? body.boxScore ?? 0),
        };
      })
      .filter(Boolean);

    const faces = rawFaces
      .map((face, index) => {
        const box = normalizeBox(face.box);

        const score = Number(
          face.faceScore ?? face.boxScore ?? face.score ?? 0,
        );

        const embedding =
          score >= 0.7 ? validateEmbedding(face.embedding) : null;

        return {
          index,
          box,
          score: Number.isFinite(score) ? score : 0,
          embedding,
        };
      })
      .filter((face) => face.box);

    logDetectionDiagnostic({
      imageBuffer,
      width,
      height,
      result,
      bodies,
      faces,
    });

    const personDetected = bodies.length > 0 || faces.length > 0;

    const validEmbeddings = faces.filter((face) => face.embedding);

    const response = {
      personDetected,

      bodyCount: bodies.length,
      faceCount: faces.length,

      bodies,
      faces,

      embedding:
        validEmbeddings.length === 1 ? validEmbeddings[0].embedding : null,

      detectionScore: faces[0]?.score || bodies[0]?.score || 0,

      modelName: MODEL_NAME,
      imageWidth: width,
      imageHeight: height,

      message: "",
    };

    if (!personDetected) {
      response.message = "Không phát hiện người";
    } else if (faces.length === 0) {
      response.message = "Phát hiện người nhưng chưa nhìn thấy khuôn mặt";
    } else if (validEmbeddings.length === 0) {
      response.message = "Có khuôn mặt nhưng chưa đủ rõ để nhận diện";
    } else {
      response.message = `Phát hiện ${bodies.length} người và ${faces.length} khuôn mặt`;
    }

    return response;
  } catch (error) {
    console.error("[FACE AI] ANALYZE FRAME ERROR:", {
      message: error.message,
      stack: error.stack,
      imageBytes: imageBuffer?.length || 0,
    });

    throw error;
  } finally {
    if (imageTensor) imageTensor.dispose();
    if (floatImage) floatImage.dispose();
    if (decodedImage) decodedImage.dispose();
  }
}

// ======================================================
// EXTRACT FACE EMBEDDING
// ======================================================

async function extractFaceEmbedding(imageBuffer) {
  const result = await analyzeFrame(imageBuffer);

  if (!result.personDetected || result.faceCount === 0) {
    throw new Error("Không tìm thấy khuôn mặt trong ảnh");
  }

  if (result.faceCount > 1) {
    throw new Error("Ảnh có nhiều hơn một khuôn mặt");
  }

  const face = result.faces.find((item) => item.embedding);

  if (!face) {
    throw new Error("Không thể trích xuất khuôn mặt");
  }

  return {
    embedding: face.embedding,
    detectionScore: face.score,
    modelName: result.modelName,
    imageWidth: result.imageWidth,
    imageHeight: result.imageHeight,
  };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  getHuman,
  analyzeFrame,
  extractFaceEmbedding,
  validateEmbedding,
  MODEL_NAME,
};
