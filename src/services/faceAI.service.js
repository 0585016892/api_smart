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
      maxDetected: 10,
      minConfidence: 0.6,
    },
    mesh: { enabled: true },
    description: { enabled: true },
  },

  body: {
    enabled: true,
    detector: {
      maxDetected: 10,
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

  if (values.length < 64 || !values.every(Number.isFinite)) {
    return null;
  }

  return values;
}

function normalizeBox(box) {
  if (!Array.isArray(box) || box.length < 4) return null;

  const values = box.slice(0, 4).map(Number);

  if (!values.every(Number.isFinite)) return null;

  const [x, y, width, height] = values;

  if (width <= 0 || height <= 0) return null;

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

    const personDetected = bodies.length > 0 || faces.length > 0;

    const validEmbeddings = faces.filter((face) => face.embedding);

    const response = {
      personDetected,

      bodyCount: bodies.length,
      faceCount: faces.length,

      bodies,
      faces,

      // Tương thích với những nơi đang sử dụng một embedding.
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
  } finally {
    if (imageTensor) imageTensor.dispose();
    if (floatImage) floatImage.dispose();
    if (decodedImage) decodedImage.dispose();
  }
}

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

module.exports = {
  getHuman,
  analyzeFrame,
  extractFaceEmbedding,
  validateEmbedding,
  MODEL_NAME,
};
