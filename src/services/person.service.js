const { pool } = require("../config/database");

const generatePersonCode = () => {
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();

  return `PER-${Date.now()}-${random}`;
};

const getPersonById = async (id) => {
  const [rows] = await pool.execute(
    `SELECT
      p.*,

      (SELECT COUNT(*)
       FROM face_profiles fp
       WHERE fp.person_id = p.id
       AND fp.status = 'active') AS face_count,

      (SELECT COUNT(*)
       FROM recognition_events re
       WHERE re.person_id = p.id
       AND re.recognition_status = 'known') AS recognition_count,

      u.full_name AS created_by_name

    FROM persons p

    LEFT JOIN users u
      ON u.id = p.created_by

    WHERE p.id = ?
    LIMIT 1`,
    [id],
  );

  return rows[0] || null;
};

const getPersonFaceProfiles = async (personId) => {
  const [rows] = await pool.execute(
    `SELECT
      id,
      person_id,
      image_path,
      model_name,
      image_quality,
      status,
      created_at

    FROM face_profiles

    WHERE person_id = ?

    ORDER BY created_at DESC`,
    [personId],
  );

  return rows;
};

const createPerson = async (data, createdBy) => {
  const personCode = generatePersonCode();

  const [result] = await pool.execute(
    `INSERT INTO persons (
      person_code,
      full_name,
      phone,
      email,
      description,
      avatar_path,
      category,
      status,
      created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      personCode,
      data.full_name,
      data.phone || null,
      data.email || null,
      data.description || null,
      data.avatar_path || null,
      data.category || "other",
      data.status || "active",
      createdBy,
    ],
  );

  return await getPersonById(result.insertId);
};

module.exports = {
  getPersonById,
  getPersonFaceProfiles,
  createPerson,
};
