const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const {
  createUploadMiddleware,
  persistUploadedFile,
  deleteStoredFile,
  removeTempFile
} = require('../storage');
const { bookingSubmitLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const uploadSingle = createUploadMiddleware('file');

const VALID_MATERIALS = ['PLA', 'PETG'];
const VALID_DURATIONS = [0.5, 1, 1.5, 2];
const MAX_LEN = {
  courseStream: 50,
  timetableStream: 50,
  team: 100,
  project: 200,
  notes: 500
};

async function rejectWithTempCleanup(res, statusCode, message, file) {
  await removeTempFile(file && file.path);
  return res.status(statusCode).json({ error: message });
}

router.get('/', async (_req, res) => {
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
        b.status,
        p.label AS printer_label,
        p.name AS printer_name,
        TO_CHAR(b.created_at, 'HH24:MI') AS booking_time,
        TO_CHAR(b.created_at, 'DD Mon') AS booking_date,
        ROW_NUMBER() OVER (PARTITION BY b.printer_id ORDER BY b.created_at) AS queue_position
      FROM bookings b
      JOIN printers p ON p.id = b.printer_id
      WHERE b.status = 'queued'
      ORDER BY b.printer_id, b.created_at
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching bookings:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

router.post(
  '/',
  bookingSubmitLimiter,
  (req, res, next) => {
    uploadSingle(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Uploaded file is too large for this server.' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: err.message });
      return next();
    });
  },
  async (req, res) => {
    const { printerId, courseStream, timetableStream, team, project, material, duration, notes } = req.body;

    const printerIdNum = Number(printerId);
    if (!Number.isInteger(printerIdNum) || printerIdNum <= 0) {
      return rejectWithTempCleanup(res, 400, 'Invalid printer selection', req.file);
    }

    if (!courseStream || !timetableStream || !team || !project || !material || duration === undefined) {
      return rejectWithTempCleanup(res, 400, 'Missing required fields', req.file);
    }

    if (!VALID_MATERIALS.includes(material)) {
      return rejectWithTempCleanup(res, 400, 'Invalid material (PLA or PETG only)', req.file);
    }

    if (!VALID_DURATIONS.includes(Number(duration))) {
      return rejectWithTempCleanup(res, 400, 'Invalid duration', req.file);
    }

    const normalized = {
      courseStream: String(courseStream).trim(),
      timetableStream: String(timetableStream).trim(),
      team: String(team).trim(),
      project: String(project).trim(),
      notes: notes ? String(notes).trim() : null
    };

    if (!normalized.courseStream || !normalized.timetableStream || !normalized.team || !normalized.project) {
      return rejectWithTempCleanup(res, 400, 'Required fields cannot be blank', req.file);
    }

    if (
      normalized.courseStream.length > MAX_LEN.courseStream ||
      normalized.timetableStream.length > MAX_LEN.timetableStream ||
      normalized.team.length > MAX_LEN.team ||
      normalized.project.length > MAX_LEN.project ||
      (normalized.notes && normalized.notes.length > MAX_LEN.notes)
    ) {
      return rejectWithTempCleanup(res, 400, 'One or more fields exceed maximum length', req.file);
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a print file (.3mf recommended)' });
    }

    let persisted = null;
    try {
      const { rows: printers } = await pool.query('SELECT id, label, status FROM printers WHERE id = $1', [printerIdNum]);
      if (printers.length === 0) {
        return rejectWithTempCleanup(res, 404, 'Printer not found', req.file);
      }
      if (printers[0].status === 'maintenance') {
        return rejectWithTempCleanup(res, 400, 'Printer is under maintenance', req.file);
      }

      try {
        persisted = await persistUploadedFile(req.file);
      } catch (fileErr) {
        await removeTempFile(req.file && req.file.path);
        const statusCode = fileErr.statusCode || 500;
        const message = statusCode === 500 ? 'Failed to store uploaded file' : fileErr.message;
        return res.status(statusCode).json({ error: message });
      }

      const { rows } = await pool.query(
        `INSERT INTO bookings (
          printer_id,
          course_stream,
          timetable_stream,
          team,
          project,
          material,
          duration,
          notes,
          file_path,
          file_original_name,
          file_size,
          file_mime,
          storage_provider
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id, printer_id, course_stream, timetable_stream, team, project, material, duration, notes, status, created_at`,
        [
          printerIdNum,
          normalized.courseStream,
          normalized.timetableStream,
          normalized.team,
          normalized.project,
          material,
          Number(duration),
          normalized.notes,
          persisted.filePath,
          persisted.fileOriginalName,
          persisted.fileSize,
          persisted.fileMime,
          persisted.storageProvider
        ]
      );

      const booking = rows[0];
      return res.status(201).json({ ...booking, printer_label: printers[0].label });
    } catch (err) {
      if (persisted && persisted.filePath) {
        await deleteStoredFile(persisted.filePath, persisted.storageProvider);
      }
      console.error('Error creating booking:', err);
      return res.status(500).json({ error: 'Failed to create booking' });
    }
  }
);

router.delete('/:id', async (req, res) => {
  const bookingId = parseInt(req.params.id, 10);
  if (Number.isNaN(bookingId)) {
    return res.status(400).json({ error: 'Invalid booking ID' });
  }

  const { team } = req.body || {};
  if (!team || !String(team).trim()) {
    return res.status(400).json({ error: 'Team name required to cancel' });
  }

  try {
    const { rows } = await pool.query(
      "DELETE FROM bookings WHERE id = $1 AND status = 'queued' AND LOWER(team) = LOWER($2) RETURNING *",
      [bookingId, String(team).trim()]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found, already processed, or team name does not match' });
    }
    await deleteStoredFile(rows[0].file_path, rows[0].storage_provider || 'local');
    return res.json({ message: 'Removed from queue' });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    return res.status(500).json({ error: 'Failed to cancel' });
  }
});

module.exports = router;
