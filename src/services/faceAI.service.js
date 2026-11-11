const path = require("path");
const tf = require("@tensorflow/tfjs-node");
const Human = require("@vladmandic/human").default;

let humanInstance = null;
let initializationPromise = null;

const MODEL_NAME = "vladmandic-human-3.3.6";

const modelDirectory = path.resolve(
  __dirname,
  "../../node_modules/@vladmandic/human/models",
);

const modelBasePath = `file://${modelDirectory.replace(/\\/g, "/")}/`;

const humanConfig = {
  backend: "tensorflow",
  modelBasePath,

  debug: false,
  cacheModels: false,

  face: {
    enabled: true,
    detector: {
      rotation: true,
      maxDetected: 5,
      minConfidence: 0.6,
    },
    mesh: {
      enabled: true,
    },
    description: {
      enabled: true,
    },
  },

  // Bật phát hiện người, kể cả khi không nhìn thấy mặt.
  body: {
    enabled: true,
    detector: {
      maxDetected: 5,
      minConfidence: 0.5,
    },
  },

  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
};

async function getHuman() {
  if (humanInstance) return humanInstance;

  if (!initializationPromise) {
    initializationPromise = (async () => {
      const human = new Human(humanConfig);

      await human.load();

      humanInstance = human;

      console.log("[FACE AI] Models loaded successfully");

      return human;
    })().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

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

  if (values.length < 64 || !values.every((value) => Number.isFinite(value))) {
    return null;
  }

  return values;
}

/**
 * Phân tích một frame:
 * - Phát hiện người bằng Body Detection.
 * - Phát hiện khuôn mặt bằng Face Detection.
 * - Trả embedding nếu có đúng một khuôn mặt đủ rõ.
 *
 * Không ghi database và không gửi Telegram tại đây.
 */
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
      throw new Error("Ảnh quá nhỏ, vui lòng chọn ảnh rõ nét hơn");
    }

    if (width > 4096 || height > 4096) {
      throw new Error("Kích thước ảnh vượt quá giới hạn xử lý");
    }

    floatImage = decodedImage.toFloat();
    imageTensor = floatImage.expandDims(0);

    const result = await human.detect(imageTensor);

    const bodies = result.body || [];
    const faces = result.face || [];

    // Có thể nhận diện người bằng body hoặc khuôn mặt.
    const personDetected = bodies.length > 0 || faces.length > 0;

    const response = {
      personDetected,
      bodyCount: bodies.length,
      faceCount: faces.length,
      embedding: null,
      detectionScore: 0,
      modelName: MODEL_NAME,
      imageWidth: width,
      imageHeight: height,
      message: "",
    };

    if (!personDetected) {
      response.message = "Không phát hiện người";
      return response;
    }

    if (faces.length === 0) {
      response.message = "Phát hiện người nhưng không nhìn thấy khuôn mặt";
      return response;
    }

    if (faces.length > 1) {
      response.message = "Phát hiện nhiều khuôn mặt trong ảnh";
      return response;
    }

    const face = faces[0];

    const score = Number(face.faceScore ?? face.boxScore ?? 0);

    response.detectionScore = Number.isFinite(score) ? score : 0;

    if (score < 0.7) {
      response.message = "Khuôn mặt chưa đủ rõ để nhận diện";
      return response;
    }

    const embedding = validateEmbedding(face.embedding);

    if (!embedding) {
      response.message = "Không thể trích xuất embedding khuôn mặt";
      return response;
    }

    response.embedding = embedding;
    response.message = "Trích xuất khuôn mặt thành công";

    return response;
  } finally {
    if (imageTensor) imageTensor.dispose();
    if (floatImage) floatImage.dispose();
    if (decodedImage) decodedImage.dispose();
  }
}

/**
 * Giữ tương thích với những nơi đang gọi extractFaceEmbedding().
 */
async function extractFaceEmbedding(imageBuffer) {
  const result = await analyzeFrame(imageBuffer);

  if (!result.personDetected || result.faceCount === 0) {
    throw new Error("Không tìm thấy khuôn mặt trong ảnh");
  }

  if (result.faceCount > 1) {
    throw new Error("Ảnh có nhiều hơn một khuôn mặt");
  }

  if (!result.embedding) {
    throw new Error(result.message || "Không thể trích xuất khuôn mặt");
  }

  return {
    embedding: result.embedding,
    detectionScore: result.detectionScore,
    modelName: result.modelName,
    imageWidth: result.imageWidth,
    imageHeight: result.imageHeight,
  };
}

module.exports = {
  getHuman,
  analyzeFrame,
  extractFaceEmbedding,
  MODEL_NAME,
};
