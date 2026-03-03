const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { deleteStoredFile, getUploadsDir } = require('./storage');

const cleanupIntervalMinutes = Math.max(5, Number(process.env.CLEANUP_INTERVAL_MINUTES || 60));
const fileRetentionDays = Math.max(1, Number(process.env.FILE_RETENTION_DAYS || 45));
const cleanupBatchSize = Math.max(10, Number(process.env.CLEANUP_BATCH_SIZE || 200));

async function runRetentionCleanup() {
  const cutoff = new Date(Date.now() - fileRetentionDays * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query(
    `SELECT id, file_path, storage_provider
     FROM bookings
     WHERE file_path IS NOT NULL
       AND status IN ('completed', 'rejected')
       AND created_at < $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [cutoff, cleanupBatchSize]
  );

  let cleaned = 0;
  for (const row of rows) {
    const removed = await deleteStoredFile(row.file_path, row.storage_provider || 'local');
    if (removed) {
      await pool.query(
        `UPDATE bookings
         SET file_path = NULL,
             file_original_name = NULL,
             file_size = NULL,
             file_mime = NULL
         WHERE id = $1`,
        [row.id]
      );
      cleaned += 1;
    }
  }

  return cleaned;
}

async function runLocalOrphanCleanup() {
  const uploadsDir = getUploadsDir();
  const { rows } = await pool.query(
    `SELECT file_path
     FROM bookings
     WHERE storage_provider = 'local' AND file_path IS NOT NULL`
  );

  const referenced = new Set(rows.map((row) => row.file_path));
  const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true });
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fileName = entry.name;
    if (referenced.has(fileName)) continue;

    const fullPath = path.join(uploadsDir, fileName);
    try {
      const stats = await fs.promises.stat(fullPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 30 * 60 * 1000) continue;
      await fs.promises.unlink(fullPath);
      removed += 1;
    } catch {
      // Skip files that disappear between stat and unlink.
    }
  }

  return removed;
}

async function runMaintenanceCycle() {
  try {
    const retained = await runRetentionCleanup();
    const orphans = await runLocalOrphanCleanup();
    if (retained > 0 || orphans > 0) {
      console.log(`[maintenance] cleaned files: retained=${retained}, orphaned=${orphans}`);
    }
  } catch (err) {
    console.error('[maintenance] cleanup cycle failed:', err);
  }
}

function startMaintenanceJobs() {
  if (String(process.env.ENABLE_MAINTENANCE_JOBS || 'true') !== 'true') {
    return;
  }

  setTimeout(runMaintenanceCycle, 10 * 1000);
  setInterval(runMaintenanceCycle, cleanupIntervalMinutes * 60 * 1000);
  console.log(`[maintenance] enabled (every ${cleanupIntervalMinutes} min, retention ${fileRetentionDays} days)`);
}

module.exports = {
  startMaintenanceJobs,
  runMaintenanceCycle
};
