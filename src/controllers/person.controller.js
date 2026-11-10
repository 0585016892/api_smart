const { pool } = require("../config/database");

const {
  getPersonById,
  getPersonFaceProfiles,
  createPerson,
} = require("../services/person.service");

const {
  savePersonAvatar,
  deleteUploadedFile,
} = require("../utils/fileStorage");

const VALID_CATEGORIES = ["family", "friend", "employee", "visitor", "other"];

const VALID_STATUSES = ["active", "inactive"];

const cleanString = (value) => {
  if (typeof value !== "string") return null;

  const result = value.trim();

  return result || null;
};

const validatePersonData = (data, isUpdate = false) => {
  const errors = [];

  if (!isUpdate || Object.prototype.hasOwnProperty.call(data, "full_name")) {
    if (
      typeof data.full_name !== "string" ||
      !data.full_name.trim() ||
      data.full_name.trim().length > 150
    ) {
      errors.push("Họ tên không hợp lệ hoặc vượt quá 150 ký tự");
    }
  }

  if (
    data.phone !== undefined &&
    data.phone !== null &&
    (typeof data.phone !== "string" || data.phone.length > 30)
  ) {
    errors.push("Số điện thoại không hợp lệ");
  }

  if (
    data.email !== undefined &&
    data.email !== null &&
    (typeof data.email !== "string" ||
      data.email.length > 190 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
  ) {
    errors.push("Email không hợp lệ");
  }

  if (
    data.category !== undefined &&
    !VALID_CATEGORIES.includes(data.category)
  ) {
    errors.push("Nhóm người không hợp lệ");
  }

  if (data.status !== undefined && !VALID_STATUSES.includes(data.status)) {
    errors.push("Trạng thái không hợp lệ");
  }

  if (
    data.description !== undefined &&
    data.description !== null &&
    (typeof data.description !== "string" || data.description.length > 5000)
  ) {
    errors.push("Mô tả không được vượt quá 5000 ký tự");
  }

  return errors;
};

// =====================================================
// GET ALL PERSONS
// GET /api/persons
// =====================================================

const getAllPersons = async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));

    const offset = (page - 1) * limit;

    const keyword = cleanString(req.query.keyword);

    const category = cleanString(req.query.category);
    const status = cleanString(req.query.status);

    const conditions = [];
    const params = [];

    if (keyword) {
      conditions.push(`
        (
          p.full_name LIKE ?
          OR p.person_code LIKE ?
          OR p.phone LIKE ?
          OR p.email LIKE ?
        )
      `);

      const search = `%${keyword}%`;

      params.push(search, search, search, search);
    }

    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({
          success: false,
          message: "Nhóm người không hợp lệ",
        });
      }

      conditions.push("p.category = ?");
      params.push(category);
    }

    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Trạng thái không hợp lệ",
        });
      }

      conditions.push("p.status = ?");
      params.push(status);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total
       FROM persons p
       ${whereClause}`,
      params,
    );

    const total = Number(countRows[0].total);

    const [rows] = await pool.execute(
      `SELECT
        p.id,
        p.person_code,
        p.full_name,
        p.phone,
        p.email,
        p.description,
        p.avatar_path,
        p.category,
        p.status,
        p.created_at,
        p.updated_at,

        (SELECT COUNT(*)
         FROM face_profiles fp
         WHERE fp.person_id = p.id
         AND fp.status = 'active') AS face_count,

        (SELECT COUNT(*)
         FROM recognition_events re
         WHERE re.person_id = p.id
         AND re.recognition_status = 'known') AS recognition_count

       FROM persons p

       ${whereClause}

       ORDER BY p.created_at DESC

       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return res.json({
      success: true,
      data: {
        items: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// GET PERSON DETAIL
// GET /api/persons/:id
// =====================================================

const getPersonDetail = async (req, res, next) => {
  try {
    const personId = Number(req.params.id);

    if (!Number.isSafeInteger(personId) || personId <= 0) {
      return res.status(400).json({
        success: false,
        message: "ID người không hợp lệ",
      });
    }

    const person = await getPersonById(personId);

    if (!person) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy thông tin người này",
      });
    }

    const faces = await getPersonFaceProfiles(personId);

    return res.json({
      success: true,
      data: {
        ...person,
        face_profiles: faces,
      },
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// CREATE PERSON
// POST /api/persons
// =====================================================

const createPersonHandler = async (req, res, next) => {
  let savedAvatar = null;

  try {
    const errors = validatePersonData(req.body);

    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: errors[0],
        errors,
      });
    }

    savedAvatar = await savePersonAvatar(req.file);

    const data = {
      full_name: req.body.full_name.trim(),
      phone: cleanString(req.body.phone),
      email: cleanString(req.body.email),
      description: cleanString(req.body.description),
      category: req.body.category || "other",
      status: req.body.status || "active",
      avatar_path: savedAvatar?.relativePath || null,
    };

    const person = await createPerson(data, req.user.id);

    return res.status(201).json({
      success: true,
      message: "Thêm người thành công",
      data: person,
    });
  } catch (error) {
    if (savedAvatar) {
      await deleteUploadedFile(savedAvatar.relativePath);
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "Thông tin người bị trùng dữ liệu",
      });
    }

    next(error);
  }
};

// =====================================================
// UPDATE PERSON
// PUT /api/persons/:id
// =====================================================

const updatePerson = async (req, res, next) => {
  let savedAvatar = null;

  try {
    const personId = Number(req.params.id);

    if (!Number.isSafeInteger(personId) || personId <= 0) {
      return res.status(400).json({
        success: false,
        message: "ID người không hợp lệ",
      });
    }

    const errors = validatePersonData(req.body, true);

    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: errors[0],
        errors,
      });
    }

    const currentPerson = await getPersonById(personId);

    if (!currentPerson) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy người cần cập nhật",
      });
    }

    const allowedFields = [
      "full_name",
      "phone",
      "email",
      "description",
      "category",
      "status",
    ];

    const updates = [];
    const params = [];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        let value = req.body[field];

        if (field === "full_name") {
          value = value.trim();
        } else if (typeof value === "string") {
          value = value.trim() || null;
        }

        updates.push(`${field} = ?`);
        params.push(value);
      }
    }

    if (req.file) {
      savedAvatar = await savePersonAvatar(req.file);

      updates.push("avatar_path = ?");
      params.push(savedAvatar.relativePath);
    }

    if (!updates.length) {
      return res.status(400).json({
        success: false,
        message: "Không có thông tin cần cập nhật",
      });
    }

    params.push(personId);

    await pool.execute(
      `UPDATE persons
       SET ${updates.join(", ")}
       WHERE id = ?`,
      params,
    );

    if (savedAvatar && currentPerson.avatar_path) {
      await deleteUploadedFile(currentPerson.avatar_path);
    }

    const updatedPerson = await getPersonById(personId);

    return res.json({
      success: true,
      message: "Cập nhật người thành công",
      data: updatedPerson,
    });
  } catch (error) {
    if (savedAvatar) {
      await deleteUploadedFile(savedAvatar.relativePath);
    }

    next(error);
  }
};

// =====================================================
// DELETE PERSON
// DELETE /api/persons/:id
// =====================================================

const deletePerson = async (req, res, next) => {
  try {
    const personId = Number(req.params.id);

    if (!Number.isSafeInteger(personId) || personId <= 0) {
      return res.status(400).json({
        success: false,
        message: "ID người không hợp lệ",
      });
    }

    const person = await getPersonById(personId);

    if (!person) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy người cần xóa",
      });
    }

    // Chỉ xóa hồ sơ người.
    // Lịch sử nhận diện được giữ lại nhờ ON DELETE SET NULL.
    // Mẫu khuôn mặt sẽ được xóa theo ON DELETE CASCADE.

    await pool.execute("DELETE FROM persons WHERE id = ?", [personId]);

    await deleteUploadedFile(person.avatar_path);

    return res.json({
      success: true,
      message: "Đã xóa người thành công",
    });
  } catch (error) {
    next(error);
  }
};

// =====================================================
// PERSON STATISTICS
// GET /api/persons/statistics
// =====================================================

const getPersonStatistics = async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        COUNT(*) AS total_persons,

        SUM(status = 'active') AS active_persons,

        SUM(status = 'inactive') AS inactive_persons,

        SUM(category = 'family') AS family_count,

        SUM(category = 'friend') AS friend_count,

        SUM(category = 'employee') AS employee_count,

        SUM(category = 'visitor') AS visitor_count,

        SUM(category = 'other') AS other_count

      FROM persons
    `);

    const [faceRows] = await pool.execute(`
      SELECT COUNT(*) AS total_faces
      FROM face_profiles
      WHERE status = 'active'
    `);

    return res.json({
      success: true,
      data: {
        ...rows[0],
        total_faces: Number(faceRows[0].total_faces),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllPersons,
  getPersonDetail,
  createPersonHandler,
  updatePerson,
  deletePerson,
  getPersonStatistics,
};
