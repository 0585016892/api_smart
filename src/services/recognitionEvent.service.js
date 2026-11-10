const crypto = require("crypto");

const { pool } = require("../config/database");

const {
  saveRecognitionSnapshot,
  deleteRecognitionSnapshot,
} = require("../utils/recognitionStorage");

const telegramService = require("./telegram.service");

const SESSION_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.RECOGNITION_SESSION_TIMEOUT_MINUTES || 10),
);

function createEventCode() {
  return `EVT-${Date.now()}-${crypto.randomUUID()}`;
}

function createSessionCode() {
  return `SES-${Date.now()}-${crypto.randomUUID()}`;
}

function toNullableId(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    const error = new Error("ID camera không hợp lệ");
    error.statusCode = 400;
    throw error;
  }

  return parsed;
}

/**
 * Đóng các phiên đã quá thời gian không phát hiện.
 */
async function closeExpiredSessions(connection) {
  await connection.query(
    `
      UPDATE recognition_sessions
      SET
        session_status = 'closed',
        check_out_at = DATE_ADD(
          last_seen_at,
          INTERVAL ? MINUTE
        )
      WHERE
        session_status = 'open'
        AND last_seen_at < DATE_SUB(
          NOW(),
          INTERVAL ? MINUTE
        )
    `,
    [SESSION_TIMEOUT_MINUTES, SESSION_TIMEOUT_MINUTES],
  );
}

/**
 * Lưu hoặc cập nhật phiên xuất hiện của người đã nhận diện.
 */
async function updateRecognitionSession(connection, data) {
  const { personId, cameraId, snapshotPath } = data;

  if (!personId) return null;

  const [sessions] = await connection.query(
    `
      SELECT
        id,
        session_code,
        event_count
      FROM recognition_sessions
      WHERE
        person_id = ?
        AND camera_id <=> ?
        AND session_status = 'open'
        AND last_seen_at >= DATE_SUB(
          NOW(),
          INTERVAL ? MINUTE
        )
      ORDER BY last_seen_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [personId, cameraId, SESSION_TIMEOUT_MINUTES],
  );

  if (sessions.length) {
    const session = sessions[0];

    await connection.query(
      `
        UPDATE recognition_sessions
        SET
          last_seen_at = NOW(),
          snapshot_path = ?,
          event_count = event_count + 1
        WHERE id = ?
      `,
      [snapshotPath, session.id],
    );

    return {
      id: session.id,
      session_code: session.session_code,
      action: "updated",
    };
  }

  const sessionCode = createSessionCode();

  const [insertResult] = await connection.query(
    `
      INSERT INTO recognition_sessions (
        session_code,
        person_id,
        camera_id,
        recognition_status,
        check_in_at,
        last_seen_at,
        snapshot_path,
        event_count,
        session_status
      )
      VALUES (?, ?, ?, 'known', NOW(), NOW(), ?, 1, 'open')
    `,
    [sessionCode, personId, cameraId, snapshotPath],
  );

  return {
    id: insertResult.insertId,
    session_code: sessionCode,
    action: "created",
  };
}

/**
 * Gửi Telegram sau khi đã COMMIT sự kiện.
 *
 * Telegram lỗi không ảnh hưởng đến kết quả nhận diện.
 */
async function sendEventNotification(eventData) {
  if (!["known", "unknown"].includes(eventData.recognition_status)) {
    return false;
  }

  try {
    const result = await telegramService.sendRecognitionNotification({
      recognition_status: eventData.recognition_status,
      event_code: eventData.event_code,
      person_name: eventData.person_name,
      camera_name: eventData.camera_name,
      confidence: eventData.confidence,
    });

    if (!result || !result.sent) {
      console.log(
        "[TELEGRAM] Notification skipped:",
        result?.reason || "unknown_reason",
      );

      return false;
    }

    await pool.query(
      `
        UPDATE recognition_events
        SET
          notification_sent = 1,
          notification_sent_at = NOW()
        WHERE id = ?
      `,
      [eventData.id],
    );

    console.log(
      `[TELEGRAM] Notification sent for event ${eventData.event_code}`,
    );

    return true;
  } catch (error) {
    console.error("[TELEGRAM NOTIFICATION ERROR]:", error.message);

    return false;
  }
}

/**
 * Ghi nhận một lần nhận diện vào recognition_events.
 */
async function recordRecognitionEvent({
  imageBuffer,
  result,
  cameraId: rawCameraId = null,
}) {
  if (!result || !["known", "unknown", "uncertain"].includes(result.status)) {
    throw new Error("Kết quả nhận diện không hợp lệ");
  }

  const cameraId = toNullableId(rawCameraId);

  const personId =
    result.status === "known" && result.person?.id
      ? Number(result.person.id)
      : null;

  const confidence = Number.isFinite(Number(result.similarity))
    ? Math.max(0, Math.min(1, Number(result.similarity)))
    : null;

  // Lưu snapshot trước khi ghi database.
  const snapshot = await saveRecognitionSnapshot(imageBuffer);

  let connection;
  let committed = false;
  let responseData = null;

  let cameraName = "Camera không xác định";
  let personName =
    result.person?.full_name || result.person?.name || "Chưa có tên";

  try {
    connection = await pool.getConnection();

    await connection.beginTransaction();

    // Kiểm tra camera.
    if (cameraId !== null) {
      const [cameras] = await connection.query(
        `
          SELECT id, camera_name
          FROM cameras
          WHERE id = ?
            AND status = 'active'
            AND is_enabled = 1
          LIMIT 1
        `,
        [cameraId],
      );

      if (!cameras.length) {
        const error = new Error(
          "Camera không tồn tại hoặc đang bị vô hiệu hóa",
        );

        error.statusCode = 400;
        throw error;
      }

      cameraName = cameras[0].camera_name;
    }

    // Lấy tên người đã nhận diện từ database.
    if (personId) {
      const [persons] = await connection.query(
        `
          SELECT id, full_name
          FROM persons
          WHERE id = ?
          LIMIT 1
        `,
        [personId],
      );

      if (persons.length) {
        personName = persons[0].full_name;
      }
    }

    await closeExpiredSessions(connection);

    const eventCode = createEventCode();

    const [eventResult] = await connection.query(
      `
        INSERT INTO recognition_events (
          event_code,
          camera_id,
          person_id,
          recognition_status,
          direction,
          confidence,
          snapshot_path,
          face_count,
          notification_sent,
          event_at
        )
        VALUES (?, ?, ?, ?, 'unknown', ?, ?, 1, 0, NOW())
      `,
      [
        eventCode,
        cameraId,
        personId,
        result.status,
        confidence,
        snapshot.relativePath,
      ],
    );

    let session = null;

    if (result.status === "known" && personId) {
      session = await updateRecognitionSession(connection, {
        personId,
        cameraId,
        snapshotPath: snapshot.relativePath,
      });
    }

    // Hoàn thành transaction trước khi gửi Telegram.
    await connection.commit();

    committed = true;

    responseData = {
      event: {
        id: eventResult.insertId,
        event_code: eventCode,
        camera_id: cameraId,
        person_id: personId,
        recognition_status: result.status,
        direction: "unknown",
        confidence,
        snapshot_path: snapshot.relativePath,
        notification_sent: false,
      },
      session,
    };
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("ROLLBACK RECOGNITION ERROR:", rollbackError.message);
      }
    }

    throw error;
  } finally {
    if (connection) {
      connection.release();
    }

    // Chỉ xóa snapshot nếu transaction chưa COMMIT.
    if (!committed) {
      await deleteRecognitionSnapshot(snapshot.relativePath);
    }
  }

  // Gửi thông báo sau khi database đã COMMIT và connection đã release.
  if (committed) {
    try {
      const notificationResult =
        await telegramService.sendRecognitionNotification({
          event_id: responseData.event.id,
          recognition_status: result.status,
          event_code: responseData.event.event_code,
          person_name: personName,
          camera_name: cameraName,
          confidence,

          imageBuffer,
          filename: snapshot.filename,
        });

      if (notificationResult?.sent) {
        await pool.query(
          `
            UPDATE recognition_events
            SET
              notification_sent = 1,
              notification_sent_at = NOW()
            WHERE id = ?
          `,
          [responseData.event.id],
        );

        responseData.event.notification_sent = true;

        console.log(
          `[TELEGRAM] Sent ${notificationResult.type} for event ${responseData.event.event_code}`,
        );
      } else {
        console.log(
          "[TELEGRAM] Notification skipped:",
          notificationResult?.reason || "unknown_reason",
        );
      }
    } catch (error) {
      // Telegram lỗi không được làm hỏng kết quả nhận diện.
      console.error("[TELEGRAM NOTIFICATION ERROR]:", error.message);
    }
  }

  return responseData;
}

module.exports = {
  recordRecognitionEvent,
  closeExpiredSessions,
};
