const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function columnExists(client, tableName, columnName) {
  const { rows } = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS printers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        label TEXT NOT NULL UNIQUE,
        spec TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'available'
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        printer_id INTEGER REFERENCES printers(id),
        course_stream TEXT NOT NULL,
        timetable_stream TEXT NOT NULL,
        team TEXT NOT NULL,
        project TEXT NOT NULL,
        material TEXT NOT NULL,
        duration REAL NOT NULL,
        notes TEXT,
        file_path TEXT,
        file_original_name TEXT,
        file_size INTEGER,
        file_mime TEXT,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'queued',
        reject_reason TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query('ALTER TABLE bookings ALTER COLUMN printer_id DROP NOT NULL').catch(() => {});

    // Safe migrations for older schemas: add missing columns without dropping data.
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS course_stream TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS timetable_stream TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS team TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS project TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS material TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS duration REAL');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notes TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS file_path TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS file_original_name TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS file_size INTEGER');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS file_mime TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS storage_provider TEXT DEFAULT \'local\'');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT \'queued\'');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reject_reason TEXT');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()');

    const hasLegacyStream = await columnExists(client, 'bookings', 'stream');
    if (hasLegacyStream) {
      await client.query(`
        UPDATE bookings
        SET course_stream = COALESCE(NULLIF(course_stream, ''), NULLIF(stream, ''), 'Morphing Wing')
        WHERE course_stream IS NULL OR course_stream = ''
      `);
    } else {
      await client.query(`
        UPDATE bookings
        SET course_stream = 'Morphing Wing'
        WHERE course_stream IS NULL OR course_stream = ''
      `);
    }

    await client.query(`
      UPDATE bookings
      SET timetable_stream = 'Unknown'
      WHERE timetable_stream IS NULL OR timetable_stream = ''
    `);
    await client.query(`
      UPDATE bookings
      SET team = 'Unknown Team'
      WHERE team IS NULL OR team = ''
    `);
    await client.query(`
      UPDATE bookings
      SET project = 'Untitled Project'
      WHERE project IS NULL OR project = ''
    `);
    await client.query(`
      UPDATE bookings
      SET material = 'PLA'
      WHERE material IS NULL OR material = ''
    `);
    await client.query(`
      UPDATE bookings
      SET duration = 1
      WHERE duration IS NULL OR duration <= 0
    `);
    await client.query(`
      UPDATE bookings
      SET storage_provider = 'local'
      WHERE storage_provider IS NULL OR storage_provider = ''
    `);
    await client.query(`
      UPDATE bookings
      SET status = CASE
        WHEN status = 'active' THEN 'queued'
        WHEN status = 'cancelled' THEN 'rejected'
        WHEN status IN ('queued', 'printing', 'completed', 'rejected') THEN status
        ELSE 'queued'
      END
      WHERE status IS NULL OR status NOT IN ('queued', 'printing', 'completed', 'rejected') OR status IN ('active', 'cancelled')
    `);

    // Remove legacy personal-data columns for compliance.
    await client.query('ALTER TABLE bookings DROP COLUMN IF EXISTS student_name');
    await client.query('ALTER TABLE bookings DROP COLUMN IF EXISTS student_id');
    await client.query('ALTER TABLE bookings DROP COLUMN IF EXISTS stream');

    await client.query('ALTER TABLE bookings ALTER COLUMN storage_provider SET DEFAULT \'local\'').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN status SET DEFAULT \'queued\'').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN created_at SET DEFAULT NOW()').catch(() => {});

    await client.query('ALTER TABLE bookings ALTER COLUMN course_stream SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN timetable_stream SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN team SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN project SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN material SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN duration SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN status SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE bookings ALTER COLUMN storage_provider SET NOT NULL').catch(() => {});

    await client.query('CREATE INDEX IF NOT EXISTS idx_bookings_printer_status ON bookings(printer_id, status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_bookings_printer_status_created ON bookings(printer_id, status, created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_bookings_queue_order ON bookings(printer_id, created_at) WHERE status = \'queued\'');
    await client.query('CREATE INDEX IF NOT EXISTS idx_bookings_archive_order ON bookings(status, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings(created_at DESC)');

    // Drop old v1 indexes that no longer apply.
    await client.query('DROP INDEX IF EXISTS idx_one_active_per_printer');
    await client.query('DROP INDEX IF EXISTS idx_bookings_student_active');

    const { rows: existingPrinters } = await client.query('SELECT COUNT(*) FROM printers');
    if (parseInt(existingPrinters[0].count, 10) === 0) {
      const printers = [];
      for (let i = 1; i <= 15; i += 1) {
        const label = `MECH EK${String(i).padStart(2, '0')}`;
        printers.push(`('Bambu P1S', '${label}', '256×256×256mm · 0.4mm', 'available')`);
      }
      await client.query(`INSERT INTO printers (name, label, spec, status) VALUES ${printers.join(', ')}`);
      console.log('Seeded 15 printers');
    }

    const { rows: existingAdmins } = await client.query('SELECT COUNT(*) FROM admins');
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);
    if (parseInt(existingAdmins[0].count, 10) === 0) {
      await client.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
      console.log('Created default admin account (username: admin)');
    } else {
      await client.query('UPDATE admins SET password_hash = $1 WHERE username = $2', [hash, 'admin']);
    }

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
