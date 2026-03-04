const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { adminLoginLimiter } = require('../middleware/rateLimit');
const { sendStoredFile, deleteStoredFile, getUploadsDir } = require('../storage');
const fs = require('fs');
const path = require('path');

const router = express.Router();

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: 'JWT secret is not configured on the server' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: rows[0].id, username: rows[0].username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    return res.json({ token, username: rows[0].username });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/queue', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.id,
        b.printer_id,
        b.course_stream,
        b.timetable_stream,
        b.team,
        b.project,
        b.material,
        b.duration,
        b.notes,
        b.file_path,
        b.file_original_name,
        b.file_size,
        b.file_mime,
        b.storage_provider,
        b.status,
        b.created_at,
        p.label AS printer_label,
        p.name AS printer_name,
        TO_CHAR(b.created_at, 'HH24:MI') AS booking_time,
        TO_CHAR(b.created_at, 'DD Mon YYYY') AS booking_date
      FROM bookings b
      LEFT JOIN printers p ON p.id = b.printer_id
      WHERE b.status IN ('queued', 'printing')
      ORDER BY b.created_at
    `);
    return res.json(rows);
  } catch (err) {
    console.error('Error fetching queue:', err);
    return res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

router.get('/archive', requireAdmin, async (req, res) => {
  try {
    const { status, search } = req.query;
    const allowedStatuses = new Set(['all', 'completed', 'rejected']);
    const chosenStatus = (status || 'all').toString();
    if (!allowedStatuses.has(chosenStatus)) {
      return res.status(400).json({ error: 'Invalid archive status filter' });
    }

    let query = `
      SELECT b.*, p.label AS printer_label, p.name AS printer_name,
        TO_CHAR(b.created_at, 'HH24:MI') AS booking_time,
        TO_CHAR(b.created_at, 'DD Mon YYYY') AS booking_date
      FROM bookings b
      LEFT JOIN printers p ON p.id = b.printer_id
    `;
    const conditions = [];
    const params = [];

    if (chosenStatus !== 'all') {
      params.push(chosenStatus);
      conditions.push(`b.status = $${params.length}`);
    } else {
      conditions.push("b.status IN ('completed', 'rejected')");
    }

    if (search) {
      params.push(`%${String(search).trim()}%`);
      const idx = params.length;
      conditions.push(`(
        b.team ILIKE $${idx}
        OR b.course_stream ILIKE $${idx}
        OR b.timetable_stream ILIKE $${idx}
        OR b.project ILIKE $${idx}
        OR p.label ILIKE $${idx}
      )`);
    }

    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ' ORDER BY b.created_at DESC';

    const { rows } = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('Error fetching archive:', err);
    return res.status(500).json({ error: 'Failed to fetch archive' });
  }
});

router.put('/bookings/:id/assign', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const { printerId } = req.body || {};
  const printerIdNum = Number(printerId);
  if (!Number.isInteger(printerIdNum) || printerIdNum <= 0) {
    return res.status(400).json({ error: 'Invalid printer ID' });
  }
  try {
    const { rows: printers } = await pool.query('SELECT id, status FROM printers WHERE id = $1', [printerIdNum]);
    if (printers.length === 0) return res.status(404).json({ error: 'Printer not found' });
    if (printers[0].status === 'maintenance') return res.status(400).json({ error: 'Printer is under maintenance' });

    const { rows } = await pool.query(
      "UPDATE bookings SET printer_id = $2 WHERE id = $1 AND status IN ('queued', 'printing') RETURNING *",
      [id, printerIdNum]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found or already processed' });
    return res.json({ message: 'Printer assigned', booking: rows[0] });
  } catch (err) {
    console.error('Error assigning printer:', err);
    return res.status(500).json({ error: 'Failed to assign printer' });
  }
});

router.put('/bookings/:id/printing', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const { rows: existing } = await pool.query(
      'SELECT id, status, printer_id FROM bookings WHERE id = $1',
      [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Booking not found' });
    if (existing[0].status !== 'queued') return res.status(400).json({ error: 'Booking is not queued' });
    if (!existing[0].printer_id) {
      return res.status(400).json({ error: 'Assign a printer before marking as printing' });
    }

    const { rows: printerRows } = await pool.query(
      'SELECT status FROM printers WHERE id = $1',
      [existing[0].printer_id]
    );
    if (printerRows.length === 0) {
      return res.status(400).json({ error: 'Assigned printer no longer exists' });
    }
    if (printerRows[0].status === 'maintenance') {
      return res.status(400).json({ error: 'Assigned printer is under maintenance' });
    }

    const { rows } = await pool.query(
      "UPDATE bookings SET status = 'printing' WHERE id = $1 AND status = 'queued' RETURNING *",
      [id]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'Booking status changed. Refresh and retry.' });
    return res.json({ message: 'Marked as printing', booking: rows[0] });
  } catch (err) {
    console.error('Error setting printing:', err);
    return res.status(500).json({ error: 'Failed to update status' });
  }
});

router.put('/bookings/:id/complete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const { rows } = await pool.query(
      "UPDATE bookings SET status = 'completed' WHERE id = $1 AND status IN ('queued', 'printing') RETURNING *",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found or already processed' });

    const booking = rows[0];
    let fileDeleteResult = null;
    if (booking.file_path) {
      fileDeleteResult = await deleteStoredFile(booking.file_path, booking.storage_provider || 'local');
      if (fileDeleteResult) {
        await pool.query(
          'UPDATE bookings SET file_path = NULL, file_original_name = NULL, file_size = NULL, file_mime = NULL WHERE id = $1',
          [id]
        );
      }
    }

    return res.json({ message: 'Marked as completed', booking });
  } catch (err) {
    console.error('Error completing booking:', err);
    return res.status(500).json({ error: 'Failed to complete' });
  }
});

router.put('/bookings/:id/reject', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'Rejection reason is required' });
  }

  const reasonText = String(reason).trim().slice(0, 500);
  try {
    const { rows } = await pool.query(
      "UPDATE bookings SET status = 'rejected', reject_reason = $2 WHERE id = $1 AND status IN ('queued', 'printing') RETURNING *",
      [id, reasonText]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found or already processed' });

    const booking = rows[0];
    let fileDeleteResult = null;
    if (booking.file_path) {
      fileDeleteResult = await deleteStoredFile(booking.file_path, booking.storage_provider || 'local');
      if (fileDeleteResult) {
        await pool.query(
          'UPDATE bookings SET file_path = NULL, file_original_name = NULL, file_size = NULL, file_mime = NULL WHERE id = $1',
          [id]
        );
      }
    }

    return res.json({ message: 'Rejected', booking });
  } catch (err) {
    console.error('Error rejecting booking:', err);
    return res.status(500).json({ error: 'Failed to reject' });
  }
});

router.get('/bookings/:id/file', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const { rows } = await pool.query(
      'SELECT file_path, file_original_name, file_mime, storage_provider FROM bookings WHERE id = $1',
      [id]
    );
    if (rows.length === 0 || !rows[0].file_path) {
      return res.status(404).json({ error: 'File not found' });
    }

    await sendStoredFile(res, rows[0]);
    return undefined;
  } catch (err) {
    if (err && (err.code === 'FILE_NOT_FOUND' || err.code === 'NoSuchKey' || err.name === 'NoSuchKey')) {
      return res.status(404).json({ error: 'File no longer available' });
    }
    console.error('Error downloading file:', err);
    return res.status(500).json({ error: 'Failed to download' });
  }
});

router.put('/printers/:id', requireAdmin, async (req, res) => {
  const printerId = parseInt(req.params.id, 10);
  if (Number.isNaN(printerId)) return res.status(400).json({ error: 'Invalid printer ID' });

  const { status, reason } = req.body || {};
  if (!['available', 'maintenance'].includes(status)) {
    return res.status(400).json({ error: 'Status must be "available" or "maintenance"' });
  }

  const maintenanceReason = status === 'maintenance'
    ? String(reason || '').trim().slice(0, 500)
    : null;
  if (status === 'maintenance' && !maintenanceReason) {
    return res.status(400).json({ error: 'Reason is required when setting maintenance mode' });
  }

  try {
    if (status === 'maintenance') {
      const { rows: rejected } = await pool.query(
        `UPDATE bookings
         SET status = 'rejected', reject_reason = $2
         WHERE printer_id = $1 AND status IN ('queued', 'printing')
         RETURNING id, file_path, storage_provider`,
        [printerId, maintenanceReason]
      );
      for (const row of rejected) {
        if (row.file_path) {
          const deleted = await deleteStoredFile(row.file_path, row.storage_provider || 'local');
          if (deleted) {
            await pool.query(
              'UPDATE bookings SET file_path = NULL, file_original_name = NULL, file_size = NULL, file_mime = NULL WHERE id = $1',
              [row.id]
            );
          }
        }
      }
    }

    const { rows } = await pool.query(
      'UPDATE printers SET status = $1 WHERE id = $2 RETURNING *',
      [status, printerId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Printer not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('Error updating printer:', err);
    return res.status(500).json({ error: 'Failed to update printer' });
  }
});

router.get('/stats', requireAdmin, async (_req, res) => {
  try {
    const [
      totalResult,
      queuedResult,
      printingResult,
      completedResult,
      rejectedResult,
      printerStats,
      streamStats,
      materialStats,
      laserBooked,
      windBooked
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM bookings'),
      pool.query("SELECT COUNT(*) FROM bookings WHERE status = 'queued'"),
      pool.query("SELECT COUNT(*) FROM bookings WHERE status = 'printing'"),
      pool.query("SELECT COUNT(*) FROM bookings WHERE status = 'completed'"),
      pool.query("SELECT COUNT(*) FROM bookings WHERE status = 'rejected'"),
      pool.query(`
        SELECT p.label, p.status,
          COUNT(b.id) FILTER (WHERE b.status IN ('queued', 'printing')) AS queued,
          COUNT(b.id) FILTER (WHERE b.status = 'completed') AS completed,
          COUNT(b.id) AS total_bookings
        FROM printers p
        LEFT JOIN bookings b ON b.printer_id = p.id
        GROUP BY p.id, p.label, p.status
        ORDER BY p.id
      `),
      pool.query('SELECT course_stream AS stream, COUNT(*) AS count FROM bookings GROUP BY course_stream ORDER BY count DESC'),
      pool.query('SELECT material, COUNT(*) AS count FROM bookings GROUP BY material ORDER BY count DESC'),
      pool.query("SELECT COUNT(*) FROM slot_bookings WHERE resource_type = 'laser_cutter' AND status = 'booked'"),
      pool.query("SELECT COUNT(*) FROM slot_bookings WHERE resource_type = 'wind_tunnel' AND status = 'booked'")
    ]);

    return res.json({
      totalBookings: parseInt(totalResult.rows[0].count, 10),
      queuedBookings: parseInt(queuedResult.rows[0].count, 10),
      printingBookings: parseInt(printingResult.rows[0].count, 10),
      completedBookings: parseInt(completedResult.rows[0].count, 10),
      rejectedBookings: parseInt(rejectedResult.rows[0].count, 10),
      printerStats: printerStats.rows,
      streamStats: streamStats.rows,
      materialStats: materialStats.rows,
      laserBookedCount: parseInt(laserBooked.rows[0].count, 10),
      windBookedCount: parseInt(windBooked.rows[0].count, 10)
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/export', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.id, p.label AS printer, b.course_stream, b.timetable_stream, b.team,
        b.project, b.file_original_name, b.material, b.duration, b.notes, b.status,
        b.reject_reason, b.storage_provider,
        TO_CHAR(b.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
      FROM bookings b
      LEFT JOIN printers p ON p.id = b.printer_id
      ORDER BY b.created_at DESC
    `);

    const headers = [
      'ID',
      'Printer',
      'Course',
      'Timetable Stream',
      'Team',
      'Project',
      'File',
      'Material',
      'Duration (hrs)',
      'Notes',
      'Status',
      'Reject Reason',
      'Storage',
      'Created At'
    ];
    const csvRows = [headers.join(',')];
    for (const row of rows) {
      csvRows.push([
        row.id,
        `"${(row.printer || '').replace(/"/g, '""')}"`,
        `"${(row.course_stream || '').replace(/"/g, '""')}"`,
        `"${(row.timetable_stream || '').replace(/"/g, '""')}"`,
        `"${(row.team || '').replace(/"/g, '""')}"`,
        `"${(row.project || '').replace(/"/g, '""')}"`,
        `"${(row.file_original_name || '').replace(/"/g, '""')}"`,
        `"${(row.material || '').replace(/"/g, '""')}"`,
        row.duration,
        `"${(row.notes || '').replace(/"/g, '""')}"`,
        row.status,
        `"${(row.reject_reason || '').replace(/"/g, '""')}"`,
        row.storage_provider,
        `"${(row.created_at || '').replace(/"/g, '""')}"`
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bookings_export.csv"');
    return res.send(csvRows.join('\n'));
  } catch (err) {
    console.error('Error exporting:', err);
    return res.status(500).json({ error: 'Failed to export' });
  }
});

router.get('/slot-bookings', requireAdmin, async (req, res) => {
  const { type, status } = req.query;
  const validTypes = ['laser_cutter', 'wind_tunnel'];
  const validStatuses = ['booked', 'completed', 'cancelled'];
  if (type && !validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid resource type' });
  }
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }
  try {
    const conditions = [];
    const params = [];
    if (type) { params.push(type); conditions.push(`resource_type = $${params.length}`); }
    if (status) {
      params.push(status); conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT *, TO_CHAR(slot_date, 'YYYY-MM-DD') AS date_str,
              TO_CHAR(slot_time, 'HH24:MI') AS time_str,
              TO_CHAR(created_at, 'DD Mon YYYY HH24:MI') AS created_str
       FROM slot_bookings${where}
       ORDER BY slot_date DESC, slot_time DESC`,
      params
    );
    return res.json(rows);
  } catch (err) {
    console.error('Error fetching slot bookings:', err);
    return res.status(500).json({ error: 'Failed to fetch slot bookings' });
  }
});

router.put('/slot-bookings/:id/complete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const { rows } = await pool.query(
      "UPDATE slot_bookings SET status = 'completed' WHERE id = $1 AND status = 'booked' RETURNING *",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found or not active' });
    const booking = rows[0];
    if (booking.file_path) {
      const deleted = await deleteStoredFile(booking.file_path, booking.storage_provider || 'local');
      if (deleted) {
        await pool.query(
          'UPDATE slot_bookings SET file_path = NULL, file_original_name = NULL, file_size = NULL, file_mime = NULL WHERE id = $1',
          [id]
        );
      }
    }
    return res.json({ message: 'Marked as completed', booking });
  } catch (err) {
    console.error('Error completing slot booking:', err);
    return res.status(500).json({ error: 'Failed to complete' });
  }
});

router.put('/slot-bookings/:id/cancel', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const { rows } = await pool.query(
      "UPDATE slot_bookings SET status = 'cancelled' WHERE id = $1 AND status = 'booked' RETURNING *",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found or not active' });
    const booking = rows[0];
    if (booking.file_path) {
      const deleted = await deleteStoredFile(booking.file_path, booking.storage_provider || 'local');
      if (deleted) {
        await pool.query(
          'UPDATE slot_bookings SET file_path = NULL, file_original_name = NULL, file_size = NULL, file_mime = NULL WHERE id = $1',
          [id]
        );
      }
    }
    return res.json({ message: 'Booking cancelled', booking });
  } catch (err) {
    console.error('Error cancelling slot booking:', err);
    return res.status(500).json({ error: 'Failed to cancel' });
  }
});

router.get('/slot-bookings/:id/file', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const { rows } = await pool.query(
      'SELECT file_path, file_original_name, file_mime, storage_provider FROM slot_bookings WHERE id = $1',
      [id]
    );
    if (rows.length === 0 || !rows[0].file_path) {
      return res.status(404).json({ error: 'File not found' });
    }
    await sendStoredFile(res, rows[0]);
    return undefined;
  } catch (err) {
    if (err && (err.code === 'FILE_NOT_FOUND' || err.code === 'NoSuchKey' || err.name === 'NoSuchKey')) {
      return res.status(404).json({ error: 'File no longer available' });
    }
    console.error('Error downloading slot file:', err);
    return res.status(500).json({ error: 'Failed to download' });
  }
});

router.delete('/nuke', requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  const nukePassword = process.env.NUKE_PASSWORD || 'luca';
  if (!password || password !== nukePassword) {
    return res.status(403).json({ error: 'Incorrect nuke password' });
  }

  try {
    const { rows } = await pool.query(
      "SELECT id, file_path, storage_provider FROM bookings WHERE file_path IS NOT NULL"
    );
    let cleaned = 0;
    for (const row of rows) {
      const deleted = await deleteStoredFile(row.file_path, row.storage_provider || 'local');
      if (deleted) cleaned++;
    }

    const uploadsDir = getUploadsDir();
    const tmpDir = path.join(uploadsDir, 'tmp');
    for (const dir of [uploadsDir, tmpDir]) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile()) await fs.promises.unlink(path.join(dir, e.name)).catch(() => {});
        }
      } catch { /* dir may not exist */ }
    }

    const { rows: slotFiles } = await pool.query(
      "SELECT id, file_path, storage_provider FROM slot_bookings WHERE file_path IS NOT NULL"
    );
    for (const row of slotFiles) {
      const deleted = await deleteStoredFile(row.file_path, row.storage_provider || 'local');
      if (deleted) cleaned++;
    }

    await pool.query('TRUNCATE bookings, slot_bookings RESTART IDENTITY');
    console.log(`[nuke] Wiped all bookings and ${cleaned} files`);
    return res.json({ message: 'All data wiped', filesDeleted: cleaned });
  } catch (err) {
    console.error('Nuke error:', err);
    return res.status(500).json({ error: 'Nuke failed' });
  }
});

module.exports = router;
