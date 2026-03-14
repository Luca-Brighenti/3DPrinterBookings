const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const {
  createUploadFieldsMiddleware,
  persistUploadedFile,
  deleteStoredFile,
  removeTempFile
} = require('../storage');
const { bookingSubmitLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const uploadCncFiles = createUploadFieldsMiddleware(
  [
    { name: 'topSurfaceFile', maxCount: 1 },
    { name: 'bottomSurfaceFile', maxCount: 1 },
    { name: 'leadingEdgeFile', maxCount: 1 }
  ],
  { allowedExtensions: ['.step'] }
);

function asArray(obj, key) {
  return (obj && obj[key] && Array.isArray(obj[key])) ? obj[key] : [];
}

function firstFile(files, key) {
  const arr = asArray(files, key);
  return arr.length > 0 ? arr[0] : null;
}

async function cleanupTempFiles(files) {
  const flat = [];
  for (const key of ['topSurfaceFile', 'bottomSurfaceFile', 'leadingEdgeFile']) {
    flat.push(...asArray(files, key));
  }
  for (const f of flat) {
    await removeTempFile(f && f.path);
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

async function getCncLiveValue() {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = 'cnc_live' LIMIT 1"
  );
  if (rows.length === 0) return false;
  const v = String(rows[0].value || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

router.get('/live', async (_req, res) => {
  try {
    const isLive = await getCncLiveValue();
    res.json({ isLive });
  } catch (err) {
    console.error('Error reading CNC live status:', err);
    res.status(500).json({ error: 'Failed to read CNC live status' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, course_stream, timetable_stream, team, project, status, is_legacy, legacy_note,
              top_file_original_name, bottom_file_original_name, leading_file_original_name,
              TO_CHAR(created_at, 'DD Mon YYYY HH24:MI') AS created_str
       FROM cnc_bookings
       WHERE status = 'queued'
       ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching CNC queue:', err);
    res.status(500).json({ error: 'Failed to fetch CNC queue' });
  }
});

router.get('/ready', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, timetable_stream, team, project, is_legacy, legacy_note,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(completed_at, created_at)) * 1000)::bigint AS completed_at_ms,
              FLOOR(EXTRACT(EPOCH FROM (COALESCE(completed_at, created_at) + INTERVAL '48 hours')) * 1000)::bigint AS due_at_ms,
              TO_CHAR(COALESCE(completed_at, created_at), 'DD Mon') AS completed_date
       FROM cnc_bookings
       WHERE status = 'completed'
       ORDER BY COALESCE(completed_at, created_at) DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching CNC ready jobs:', err);
    res.status(500).json({ error: 'Failed to fetch ready jobs' });
  }
});

router.get('/rejected', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT timetable_stream, team, project, reject_reason, is_legacy, legacy_note,
              TO_CHAR(created_at, 'DD Mon') AS booking_date
       FROM cnc_bookings
       WHERE status = 'rejected'
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching CNC rejected jobs:', err);
    res.status(500).json({ error: 'Failed to fetch rejected jobs' });
  }
});

router.post(
  '/',
  bookingSubmitLimiter,
  (req, res, next) => {
    uploadCncFiles(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large.' });
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: err.message });
      return next();
    });
  },
  async (req, res) => {
    const courseStream = normalizeText(req.body.courseStream);
    const timetableStream = normalizeText(req.body.timetableStream);
    const team = normalizeText(req.body.team);
    const project = normalizeText(req.body.project);

    const topFile = firstFile(req.files, 'topSurfaceFile');
    const bottomFile = firstFile(req.files, 'bottomSurfaceFile');
    const leadingFile = firstFile(req.files, 'leadingEdgeFile');

    if (!courseStream || !timetableStream || !team || !project) {
      await cleanupTempFiles(req.files);
      return res.status(400).json({ error: 'Course, timetable stream, team, and project are required' });
    }
    if (!topFile && !bottomFile && !leadingFile) {
      await cleanupTempFiles(req.files);
      return res.status(400).json({ error: 'Upload at least one STEP file (.step)' });
    }

    let topStored = null;
    let bottomStored = null;
    let leadingStored = null;
    try {
      if (topFile) topStored = await persistUploadedFile(topFile);
      if (bottomFile) bottomStored = await persistUploadedFile(bottomFile);
      if (leadingFile) leadingStored = await persistUploadedFile(leadingFile);

      const { rows } = await pool.query(
        `INSERT INTO cnc_bookings (
          course_stream, timetable_stream, team, project,
          top_file_path, top_file_original_name, top_file_size, top_file_mime,
          bottom_file_path, bottom_file_original_name, bottom_file_size, bottom_file_mime,
          leading_file_path, leading_file_original_name, leading_file_size, leading_file_mime,
          storage_provider, status
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, 'queued'
        )
        RETURNING id, course_stream, timetable_stream, team, project, status, created_at`,
        [
          courseStream, timetableStream, team, project,
          topStored ? topStored.filePath : null,
          topStored ? topStored.fileOriginalName : null,
          topStored ? topStored.fileSize : null,
          topStored ? topStored.fileMime : null,
          bottomStored ? bottomStored.filePath : null,
          bottomStored ? bottomStored.fileOriginalName : null,
          bottomStored ? bottomStored.fileSize : null,
          bottomStored ? bottomStored.fileMime : null,
          leadingStored ? leadingStored.filePath : null,
          leadingStored ? leadingStored.fileOriginalName : null,
          leadingStored ? leadingStored.fileSize : null,
          leadingStored ? leadingStored.fileMime : null,
          (topStored && topStored.storageProvider) || (bottomStored && bottomStored.storageProvider) || (leadingStored && leadingStored.storageProvider) || 'local'
        ]
      );
      return res.status(201).json(rows[0]);
    } catch (err) {
      for (const saved of [topStored, bottomStored, leadingStored]) {
        if (saved && saved.filePath) {
          await deleteStoredFile(saved.filePath, saved.storageProvider || 'local');
        }
      }
      await cleanupTempFiles(req.files);
      console.error('Error creating CNC booking:', err);
      return res.status(500).json({ error: 'Failed to create CNC booking' });
    }
  }
);

router.put('/:id/collect', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });
  const team = normalizeText(req.body.team);
  const timetableStream = normalizeText(req.body.timetableStream);
  if (!team || !timetableStream) {
    return res.status(400).json({ error: 'Team and timetable stream are required' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE cnc_bookings
       SET status = 'collected', collected_at = NOW()
       WHERE id = $1
         AND status = 'completed'
         AND LOWER(team) = LOWER($2)
         AND LOWER(timetable_stream) = LOWER($3)
       RETURNING id`,
      [id, team, timetableStream]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Job not found or details do not match' });
    }
    return res.json({ message: 'Marked as collected' });
  } catch (err) {
    console.error('Error collecting CNC booking:', err);
    return res.status(500).json({ error: 'Failed to mark as collected' });
  }
});

module.exports = router;
