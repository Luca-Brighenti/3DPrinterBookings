const express = require('express');
const multer = require('multer');
const path = require('path');
const { pool } = require('../db');
const {
  createUploadMiddleware,
  persistUploadedFile,
  deleteStoredFile,
  removeTempFile
} = require('../storage');
const { bookingSubmitLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const uploadSingle = createUploadMiddleware('file', { allowAnyExtension: true });

const VALID_TYPES = ['laser_cutter', 'wind_tunnel'];
const LASER_ALLOWED_EXTENSIONS = new Set(['.dxf', '.svg', '.ai', '.pdf', '.3mf', '.stl']);

const SLOT_WINDOWS = [
  { day: 1, startHour: 15, startMin: 0, endHour: 17, endMin: 0 },
  { day: 3, startHour: 10, startMin: 0, endHour: 12, endMin: 0 },
  { day: 4, startHour: 15, startMin: 0, endHour: 17, endMin: 0 },
  { day: 5, startHour: 10, startMin: 0, endHour: 12, endMin: 0 },
];

function getFriendlyStorageErrorMessage(err) {
  const name = err && err.name ? String(err.name) : '';
  const msg = err && err.message ? String(err.message) : '';

  if (name === 'CredentialsProviderError' || /Could not load credentials/i.test(msg)) {
    return 'Storage credentials are missing or invalid.';
  }
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return 'Storage access keys are invalid.';
  }
  if (name === 'AccessDenied') {
    return 'Storage access denied.';
  }
  if (name === 'NoSuchBucket') {
    return 'Storage bucket not found.';
  }
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed') {
    return 'Storage region mismatch.';
  }
  return 'Failed to store uploaded file';
}

function getFileExtension(fileName) {
  return path.extname(fileName || '').toLowerCase();
}

function parseDateInput(dateStr) {
  const normalized = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function padDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function getWeekDates(dateStr) {
  const d = parseDateInput(dateStr);
  if (!d) return null;
  const dow = d.getDay();
  const diff = d.getDate() - dow + (dow === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const dt = new Date(monday);
    dt.setDate(monday.getDate() + i);
    dates.push(padDate(dt));
  }
  return { monday: dates[0], friday: dates[4], dates };
}

function isValidSlot(dateStr, timeStr) {
  if (!parseDateInput(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay();
  const [h, m] = timeStr.split(':').map(Number);
  if (m % 15 !== 0) return false;

  for (const w of SLOT_WINDOWS) {
    if (dayOfWeek !== w.day) continue;
    const slotMins = h * 60 + m;
    const startMins = w.startHour * 60 + w.startMin;
    const endMins = w.endHour * 60 + w.endMin;
    if (slotMins >= startMins && slotMins < endMins) return true;
  }
  return false;
}

function isFutureSlot(dateStr, timeStr) {
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return false;
  const slotStart = new Date(dateStr + 'T' + timeStr + ':00');
  if (Number.isNaN(slotStart.getTime())) return false;
  const slotEnd = new Date(slotStart);
  slotEnd.setMinutes(slotEnd.getMinutes() + 15);
  return slotEnd.getTime() > Date.now();
}

async function enforceSingleActiveBookingPerTeam(resourceType, timetableStream, team) {
  const { rows } = await pool.query(
    `SELECT id, file_path, storage_provider
     FROM slot_bookings
     WHERE resource_type = $1
       AND status = 'booked'
       AND LOWER(timetable_stream) = LOWER($2)
       AND LOWER(team) = LOWER($3)
     ORDER BY created_at ASC, id ASC`,
    [resourceType, timetableStream, team]
  );

  if (rows.length === 0) return false;

  const now = Date.now();
  let hasFutureActive = false;
  for (const row of rows) {
    const { rows: slotRows } = await pool.query(
      `SELECT TO_CHAR(slot_date, 'YYYY-MM-DD') AS date_str, TO_CHAR(slot_time, 'HH24:MI') AS time_str
       FROM slot_bookings WHERE id = $1`,
      [row.id]
    );
    if (!slotRows.length) continue;
    const slotEnd = new Date(slotRows[0].date_str + 'T' + slotRows[0].time_str + ':00');
    slotEnd.setMinutes(slotEnd.getMinutes() + 15);
    if (slotEnd.getTime() > now) {
      hasFutureActive = true;
    } else {
      await pool.query("UPDATE slot_bookings SET status = 'cancelled' WHERE id = $1", [row.id]);
      if (row.file_path) {
        const deleted = await deleteStoredFile(row.file_path, row.storage_provider || 'local');
        if (deleted) {
          await pool.query(
            'UPDATE slot_bookings SET file_path = NULL, file_original_name = NULL, file_size = NULL, file_mime = NULL WHERE id = $1',
            [row.id]
          );
        }
      }
    }
  }

  return hasFutureActive;
}

function generateSlotsForDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay();
  const slots = [];
  for (const w of SLOT_WINDOWS) {
    if (dayOfWeek !== w.day) continue;
    let mins = w.startHour * 60 + w.startMin;
    const endMins = w.endHour * 60 + w.endMin;
    while (mins < endMins) {
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      slots.push(hh + ':' + mm);
      mins += 15;
    }
  }
  return slots;
}

router.get('/', async (req, res) => {
  const { type, week } = req.query;
  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid resource type' });
  }
  const weekDate = week || padDate(new Date());
  const weekInfo = getWeekDates(weekDate);
  if (!weekInfo) {
    return res.status(400).json({ error: 'Invalid week format. Use YYYY-MM-DD.' });
  }
  const { monday, friday, dates } = weekInfo;

  try {
    const { rows } = await pool.query(
      `SELECT id, resource_type, slot_date, slot_time, timetable_stream, team, status,
              course_stream, file_original_name,
              TO_CHAR(slot_date, 'YYYY-MM-DD') AS date_str,
              TO_CHAR(slot_time, 'HH24:MI') AS time_str
       FROM slot_bookings
       WHERE resource_type = $1 AND slot_date >= $2::date AND slot_date <= $3::date AND status = 'booked'
       ORDER BY slot_date, slot_time`,
      [type, monday, friday]
    );

    const schedule = {};
    for (const dateStr of dates) {
      const daySlots = generateSlotsForDate(dateStr);
      if (daySlots.length > 0) {
        schedule[dateStr] = daySlots.map(t => {
          const booking = rows.find(r => r.date_str === dateStr && r.time_str === t);
          return {
            time: t,
            booked: !!booking && booking.status === 'booked',
            team: booking && booking.status === 'booked' ? booking.timetable_stream + ' — ' + booking.team : null,
            bookingId: booking ? booking.id : null
          };
        });
      }
    }

    return res.json({ monday, friday, schedule });
  } catch (err) {
    console.error('Error fetching slots:', err);
    return res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

router.post(
  '/',
  bookingSubmitLimiter,
  (req, res, next) => {
    uploadSingle(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large.' });
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: err.message });
      return next();
    });
  },
  async (req, res) => {
    const { resourceType, slotDate, slotTime, courseStream, timetableStream, team } = req.body;

    if (!resourceType || !VALID_TYPES.includes(resourceType)) {
      return rejectCleanup(res, 400, 'Invalid resource type', req.file);
    }
    if (!slotDate || !slotTime) {
      return rejectCleanup(res, 400, 'Date and time are required', req.file);
    }
    if (!courseStream || !timetableStream || !team) {
      return rejectCleanup(res, 400, 'Course, timetable stream, and team are required', req.file);
    }

    const cs = String(courseStream).trim();
    const ts = String(timetableStream).trim();
    const tm = String(team).trim();
    if (!cs || !ts || !tm) {
      return rejectCleanup(res, 400, 'Fields cannot be blank', req.file);
    }
    if (cs.length > 50 || ts.length > 50 || tm.length > 100) {
      return rejectCleanup(res, 400, 'Field too long', req.file);
    }

    const hasExistingActiveBooking = await enforceSingleActiveBookingPerTeam(resourceType, ts, tm);
    if (hasExistingActiveBooking) {
      return rejectCleanup(
        res,
        409,
        'Your team already has an active booking for this machine. Only one active booking is allowed.',
        req.file
      );
    }

    if (!parseDateInput(slotDate)) {
      return rejectCleanup(res, 400, 'Invalid date format. Use YYYY-MM-DD.', req.file);
    }

    const timeNormalized = String(slotTime).trim().slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(timeNormalized)) {
      return rejectCleanup(res, 400, 'Invalid time format. Use HH:MM.', req.file);
    }

    const slotValid = isValidSlot(slotDate, timeNormalized);
    if (!slotValid) {
      return rejectCleanup(res, 400, 'Selected time slot is not available', req.file);
    }
    if (!isFutureSlot(slotDate, timeNormalized)) {
      return rejectCleanup(res, 400, 'Cannot book a past time slot', req.file);
    }

    if (req.file && resourceType === 'laser_cutter') {
      const extension = getFileExtension(req.file.originalname);
      if (!LASER_ALLOWED_EXTENSIONS.has(extension)) {
        return rejectCleanup(
          res,
          400,
          'Laser uploads must be .dxf, .svg, .ai, .pdf, .3mf, or .stl files',
          req.file
        );
      }
    }
    let persisted = null;
    try {
      if (req.file) {
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
      }

      const { rows } = await pool.query(
        `INSERT INTO slot_bookings
          (resource_type, slot_date, slot_time, course_stream, timetable_stream, team,
           file_path, file_original_name, file_size, file_mime, storage_provider)
         VALUES ($1, $2, $3::time, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, resource_type, slot_date, slot_time, timetable_stream, team, status`,
        [
          resourceType,
          slotDate,
          timeNormalized,
          cs, ts, tm,
          persisted ? persisted.filePath : null,
          persisted ? persisted.fileOriginalName : null,
          persisted ? persisted.fileSize : null,
          persisted ? persisted.fileMime : null,
          persisted ? persisted.storageProvider : 'local'
        ]
      );

      return res.status(201).json(rows[0]);
    } catch (err) {
      if (persisted && persisted.filePath) {
        await deleteStoredFile(persisted.filePath, persisted.storageProvider);
      }
      if (err.code === '23505') {
        return res.status(409).json({ error: 'This time slot is already booked' });
      }
      console.error('Error creating slot booking:', err);
      return res.status(500).json({ error: 'Failed to create booking' });
    }
  }
);

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

  const { team } = req.body || {};
  if (!team || !String(team).trim()) {
    return res.status(400).json({ error: 'Team name required to cancel' });
  }

  try {
    const { rows } = await pool.query(
      "UPDATE slot_bookings SET status = 'cancelled' WHERE id = $1 AND status = 'booked' AND LOWER(team) = LOWER($2) RETURNING *",
      [id, String(team).trim()]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found or team name mismatch' });
    }
    if (rows[0].file_path) {
      const deleted = await deleteStoredFile(rows[0].file_path, rows[0].storage_provider || 'local');
      if (deleted) {
        await pool.query(
          'UPDATE slot_bookings SET file_path = NULL, file_original_name = NULL, file_size = NULL, file_mime = NULL WHERE id = $1',
          [id]
        );
      }
    }
    return res.json({ message: 'Booking cancelled' });
  } catch (err) {
    console.error('Error cancelling slot:', err);
    return res.status(500).json({ error: 'Failed to cancel' });
  }
});

async function rejectCleanup(res, code, msg, file) {
  await removeTempFile(file && file.path);
  return res.status(code).json({ error: msg });
}

module.exports = router;
