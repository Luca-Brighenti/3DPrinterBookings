const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/printers — all printers with queue counts
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.name, p.label, p.spec, p.status,
        COUNT(b.id) AS queue_count
      FROM printers p
      LEFT JOIN bookings b ON b.printer_id = p.id AND b.status = 'queued'
      GROUP BY p.id
      ORDER BY p.id
    `);

    for (const row of rows) {
      row.queue_count = parseInt(row.queue_count);
    }

    res.json(rows);
  } catch (err) {
    console.error('Error fetching printers:', err);
    res.status(500).json({ error: 'Failed to fetch printers' });
  }
});

module.exports = router;
