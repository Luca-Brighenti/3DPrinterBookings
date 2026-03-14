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
        completed_at TIMESTAMP,
        collected_at TIMESTAMP,
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
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP');
    await client.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS collected_at TIMESTAMP');
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
    await client.query(`
      UPDATE bookings
      SET completed_at = created_at
      WHERE status = 'completed' AND completed_at IS NULL
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
      for (let i = 1; i <= 18; i += 1) {
        const label = `MECH EK${String(i).padStart(2, '0')}`;
        printers.push(`('Bambu P1S', '${label}', '256×256×256mm · 0.4mm', 'available')`);
      }
      await client.query(`INSERT INTO printers (name, label, spec, status) VALUES ${printers.join(', ')}`);
      console.log('Seeded 18 printers');
    }

    for (let i = 1; i <= 18; i += 1) {
      const label = `MECH EK${String(i).padStart(2, '0')}`;
      await client.query(
        `INSERT INTO printers (name, label, spec, status)
         VALUES ('Bambu P1S', $1, '256×256×256mm · 0.4mm', 'available')
         ON CONFLICT (label) DO NOTHING`,
        [label]
      );
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS slot_bookings (
        id SERIAL PRIMARY KEY,
        resource_type TEXT NOT NULL,
        slot_date DATE NOT NULL,
        slot_time TIME NOT NULL,
        course_stream TEXT NOT NULL,
        timetable_stream TEXT NOT NULL,
        team TEXT NOT NULL,
        file_path TEXT,
        file_original_name TEXT,
        file_size INTEGER,
        file_mime TEXT,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'booked',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cnc_bookings (
        id SERIAL PRIMARY KEY,
        course_stream TEXT NOT NULL,
        timetable_stream TEXT NOT NULL,
        team TEXT NOT NULL,
        project TEXT NOT NULL,
        top_file_path TEXT,
        top_file_original_name TEXT,
        top_file_size INTEGER,
        top_file_mime TEXT,
        bottom_file_path TEXT,
        bottom_file_original_name TEXT,
        bottom_file_size INTEGER,
        bottom_file_mime TEXT,
        leading_file_path TEXT,
        leading_file_original_name TEXT,
        leading_file_size INTEGER,
        leading_file_mime TEXT,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'queued',
        reject_reason TEXT,
        is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
        legacy_note TEXT,
        source_slot_booking_id INTEGER,
        completed_at TIMESTAMP,
        collected_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS course_stream TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS timetable_stream TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS team TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS project TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS top_file_path TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS top_file_original_name TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS top_file_size INTEGER');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS top_file_mime TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS bottom_file_path TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS bottom_file_original_name TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS bottom_file_size INTEGER');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS bottom_file_mime TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS leading_file_path TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS leading_file_original_name TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS leading_file_size INTEGER');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS leading_file_mime TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS storage_provider TEXT DEFAULT \'local\'');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT \'queued\'');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS reject_reason TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS is_legacy BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS legacy_note TEXT');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS source_slot_booking_id INTEGER');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS collected_at TIMESTAMP');
    await client.query('ALTER TABLE cnc_bookings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()');
    await client.query(`
      UPDATE cnc_bookings
      SET status = CASE
        WHEN status IN ('queued', 'completed', 'rejected', 'collected') THEN status
        ELSE 'queued'
      END
      WHERE status IS NULL OR status NOT IN ('queued', 'completed', 'rejected', 'collected')
    `);
    await client.query(`
      UPDATE cnc_bookings
      SET completed_at = created_at
      WHERE status = 'completed' AND completed_at IS NULL
    `);
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN storage_provider SET DEFAULT \'local\'').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN status SET DEFAULT \'queued\'').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN created_at SET DEFAULT NOW()').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN course_stream SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN timetable_stream SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN team SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN project SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN storage_provider SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN status SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN is_legacy SET DEFAULT FALSE').catch(() => {});
    await client.query('UPDATE cnc_bookings SET is_legacy = FALSE WHERE is_legacy IS NULL');
    await client.query('ALTER TABLE cnc_bookings ALTER COLUMN is_legacy SET NOT NULL').catch(() => {});
    await client.query('CREATE INDEX IF NOT EXISTS idx_cnc_bookings_status_created ON cnc_bookings(status, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_cnc_bookings_queue_order ON cnc_bookings(created_at) WHERE status = \'queued\'');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_cnc_bookings_source_slot ON cnc_bookings(source_slot_booking_id) WHERE source_slot_booking_id IS NOT NULL');

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('cnc_live', 'false')
       ON CONFLICT (key) DO NOTHING`
    );

    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS resource_type TEXT');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS slot_date DATE');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS slot_time TIME');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS course_stream TEXT');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS timetable_stream TEXT');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS team TEXT');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS file_path TEXT');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS file_original_name TEXT');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS file_size INTEGER');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS file_mime TEXT');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS storage_provider TEXT DEFAULT \'local\'');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS status TEXT DEFAULT \'booked\'');
    await client.query('ALTER TABLE slot_bookings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()');

    await client.query(`
      UPDATE slot_bookings
      SET status = CASE
        WHEN status = 'active' THEN 'booked'
        WHEN status = 'canceled' THEN 'cancelled'
        WHEN status IN ('booked', 'completed', 'cancelled') THEN status
        ELSE 'booked'
      END
      WHERE status IS NULL OR status NOT IN ('booked', 'completed', 'cancelled') OR status IN ('active', 'canceled')
    `);
    await client.query(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY resource_type, LOWER(timetable_stream), LOWER(team)
            ORDER BY created_at ASC, id ASC
          ) AS rn
        FROM slot_bookings
        WHERE status = 'booked'
      )
      DELETE FROM slot_bookings
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    `);
    await client.query(`
      UPDATE slot_bookings
      SET storage_provider = 'local'
      WHERE storage_provider IS NULL OR storage_provider = ''
    `);
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN storage_provider SET DEFAULT \'local\'').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN status SET DEFAULT \'booked\'').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN created_at SET DEFAULT NOW()').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN resource_type SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN slot_date SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN slot_time SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN course_stream SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN timetable_stream SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN team SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN storage_provider SET NOT NULL').catch(() => {});
    await client.query('ALTER TABLE slot_bookings ALTER COLUMN status SET NOT NULL').catch(() => {});

    await client.query('ALTER TABLE slot_bookings DROP CONSTRAINT IF EXISTS slot_bookings_resource_type_slot_date_slot_time_key').catch(() => {});
    await client.query('DROP INDEX IF EXISTS slot_bookings_resource_type_slot_date_slot_time_key').catch(() => {});
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_unique_booked
      ON slot_bookings(resource_type, slot_date, slot_time)
      WHERE status = 'booked'
    `).catch(() => {});
    await client.query('DROP INDEX IF EXISTS idx_slot_unique_team_booked').catch(() => {});
    await client.query('CREATE INDEX IF NOT EXISTS idx_slot_bookings_resource_date ON slot_bookings(resource_type, slot_date)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_slot_bookings_status ON slot_bookings(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_slot_bookings_created_at ON slot_bookings(created_at DESC)');

    await client.query(`
      INSERT INTO cnc_bookings (
        course_stream,
        timetable_stream,
        team,
        project,
        top_file_path, top_file_original_name, top_file_size, top_file_mime,
        bottom_file_path, bottom_file_original_name, bottom_file_size, bottom_file_mime,
        leading_file_path, leading_file_original_name, leading_file_size, leading_file_mime,
        storage_provider,
        status,
        reject_reason,
        is_legacy,
        legacy_note,
        source_slot_booking_id,
        completed_at,
        created_at
      )
      SELECT
        COALESCE(NULLIF(s.course_stream, ''), 'Morphing Wing') AS course_stream,
        COALESCE(NULLIF(s.timetable_stream, ''), 'Unknown') AS timetable_stream,
        COALESCE(NULLIF(s.team, ''), 'Unknown Team') AS team,
        COALESCE(NULLIF(s.file_original_name, ''), 'Legacy CNC Slot Booking') AS project,
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        s.file_path, s.file_original_name, s.file_size, s.file_mime,
        COALESCE(NULLIF(s.storage_provider, ''), 'local') AS storage_provider,
        CASE
          WHEN s.status = 'booked' THEN 'queued'
          WHEN s.status = 'completed' THEN 'completed'
          WHEN s.status = 'cancelled' THEN 'rejected'
          ELSE 'queued'
        END AS status,
        CASE
          WHEN s.status = 'cancelled' THEN 'Legacy CNC time-slot booking (cancelled in old system)'
          ELSE NULL
        END AS reject_reason,
        TRUE AS is_legacy,
        'OLD BOOKING: Migrated from the old CNC time-slot system. Files were optional previously.' AS legacy_note,
        s.id AS source_slot_booking_id,
        CASE WHEN s.status = 'completed' THEN COALESCE(s.created_at, NOW()) ELSE NULL END AS completed_at,
        COALESCE(s.created_at, NOW()) AS created_at
      FROM slot_bookings s
      WHERE s.resource_type = 'cnc'
        AND NOT EXISTS (
          SELECT 1
          FROM cnc_bookings c
          WHERE c.source_slot_booking_id = s.id
        )
    `);

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
