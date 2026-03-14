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

function getFriendlyStorageErrorMessage(err) {
  const name = err && err.name ? String(err.name) : '';
  const msg = err && err.message ? String(err.message) : '';

  if (name === 'CredentialsProviderError' || /Could not load credentials/i.test(msg)) {
    return 'S3 credentials are missing or invalid. Check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.';
  }
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return 'S3 access key is invalid. Verify S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.';
  }
  if (name === 'AccessDenied') {
    return 'S3 access denied. Check IAM permissions for PutObject on your bucket/prefix.';
  }
  if (name === 'NoSuchBucket') {
    return 'S3 bucket not found. Verify S3_BUCKET and S3_REGION.';
  }
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed') {
    return 'S3 region mismatch. Verify S3_REGION matches the bucket region.';
  }
  return 'Failed to store uploaded file';
}

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
        b.file_original_name,
        p.label AS printer_label,
        p.name AS printer_name,
        TO_CHAR(b.created_at, 'HH24:MI') AS booking_time,
        TO_CHAR(b.created_at, 'DD Mon') AS booking_date
      FROM bookings b
      LEFT JOIN printers p ON p.id = b.printer_id
      WHERE b.status IN ('queued', 'printing')
      ORDER BY b.created_at
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching bookings:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

router.get('/rejected', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.timetable_stream,
        b.team,
        b.file_original_name,
        b.reject_reason,
        TO_CHAR(b.created_at, 'DD Mon') AS booking_date
      FROM bookings b
      WHERE b.status = 'rejected'
      ORDER BY b.created_at DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching rejected:', err);
    res.status(500).json({ error: 'Failed to fetch rejected bookings' });
  }
});

router.get('/ready', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        b.id,
        b.timetable_stream,
        b.team,
        b.project,
        b.file_original_name,
        FLOOR(EXTRACT(EPOCH FROM COALESCE(b.completed_at, b.created_at)) * 1000)::bigint AS completed_at_ms,
        FLOOR(EXTRACT(EPOCH FROM (COALESCE(b.completed_at, b.created_at) + INTERVAL '48 hours')) * 1000)::bigint AS due_at_ms,
        TO_CHAR(COALESCE(b.completed_at, b.created_at), 'DD Mon') AS completed_date
      FROM bookings b
      WHERE b.status = 'completed'
        AND b.collected_at IS NULL
      ORDER BY COALESCE(b.completed_at, b.created_at) DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching ready-for-collection bookings:', err);
    res.status(500).json({ error: 'Failed to fetch ready-for-collection bookings' });
  }
});

router.put('/ready/:id/collect', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid booking ID' });
  try {
    const { rows } = await pool.query(
      `UPDATE bookings
       SET collected_at = NOW()
       WHERE id = $1
         AND status = 'completed'
         AND collected_at IS NULL
       RETURNING id`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Collection ticket not found' });
    return res.json({ message: 'Marked as collected' });
  } catch (err) {
    console.error('Error marking print as collected:', err);
    return res.status(500).json({ error: 'Failed to mark as collected' });
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
    const { courseStream, timetableStream, team, project, material, duration, notes } = req.body;

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
      return res.status(400).json({ error: 'Please upload an STL file (.stl)' });
    }

    let persisted = null;
    try {
      try {
        persisted = await persistUploadedFile(req.file);
      } catch (fileErr) {
        await removeTempFile(req.file && req.file.path);
        const statusCode = fileErr.statusCode || 500;
        const message = statusCode === 500 ? getFriendlyStorageErrorMessage(fileErr) : fileErr.message;
        console.error('File storage error:', {
          provider: process.env.STORAGE_PROVIDER,
          name: fileErr.name,
          message: fileErr.message,
          code: fileErr.code
        });
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
        VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, course_stream, timetable_stream, team, project, material, duration, notes, status, created_at`,
        [
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
      return res.status(201).json(booking);
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
