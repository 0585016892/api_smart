const express = require("express");
const router = express.Router();

const { pool } = require("../config/database");

router.get("/", async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        DATABASE() AS database_name,
        NOW() AS server_time
    `);

    res.json({
      success: true,
      message: "Smart Face Security API đang hoạt động",
      data: {
        status: "online",
        database: "connected",
        database_name: rows[0].database_name,
        server_time: rows[0].server_time,
        version: "1.0.0",
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
