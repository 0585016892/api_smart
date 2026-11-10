const path = require("path");
const tf = require("@tensorflow/tfjs-node");
const Human = require("@vladmandic/human").default;

let humanInstance = null;
let isInitializing = false;

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

  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
};

async function getHuman() {
  if (humanInstance) return humanInstance;

  if (isInitializing) {
    while (isInitializing) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (humanInstance) return humanInstance;
  }

  isInitializing = true;

  try {
    const human = new Human(humanConfig);

    await human.load();

    humanInstance = human;

    console.log("[FACE AI] Model loaded successfully");

    return humanInstance;
  } finally {
    isInitializing = false;
  }
}

async function extractFaceEmbedding(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    throw new Error("Ảnh đầu vào không hợp lệ");
  }

  let decodedImage;
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

    imageTensor = decodedImage.toFloat().expandDims(0);

    const result = await human.detect(imageTensor);

    const faces = result.face || [];

    if (faces.length === 0) {
      throw new Error("Không tìm thấy khuôn mặt trong ảnh");
    }

    if (faces.length > 1) {
      throw new Error(
        "Ảnh có nhiều hơn một khuôn mặt. Vui lòng chọn ảnh chỉ có một người",
      );
    }

    const face = faces[0];

    if (!face.embedding || !Array.isArray(face.embedding)) {
      throw new Error("Không thể trích xuất dữ liệu khuôn mặt từ ảnh này");
    }

    if (face.embedding.length === 0) {
      throw new Error("Dữ liệu khuôn mặt không hợp lệ");
    }

    const score = Number(face.faceScore ?? face.boxScore ?? 0);
    if (score < 0.7) {
      throw new Error("Khuôn mặt chưa đủ rõ. Vui lòng chọn ảnh sáng và rõ hơn");
    }

    return {
      embedding: face.embedding.map(Number),
      detectionScore: score,
      modelName: MODEL_NAME,
      imageWidth: width,
      imageHeight: height,
    };
  } finally {
    if (imageTensor) imageTensor.dispose();
    if (decodedImage) decodedImage.dispose();
  }
}

module.exports = {
  getHuman,
  extractFaceEmbedding,
  MODEL_NAME,
};
