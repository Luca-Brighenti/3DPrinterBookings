# MECH PrintLab Booking System

Queue-based 3D printer booking system with:
- Public booking page
- Admin dashboard
- File uploads per print request
- Completed/rejected archives
- CSV export

## Production Hardening Included

- Rate limiting for API and admin login
- Response compression (`gzip`)
- Safer public queue payloads (no internal file paths)
- Optional S3-compatible storage for uploaded files
- Automated cleanup of old uploaded files
- Safer schema migration (no destructive table drop on startup)
- Maintenance mode now requires and stores a rejection reason

## Environment Variables

Required:
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_PASSWORD`
- `NODE_ENV`

Storage and upload:
- `STORAGE_PROVIDER` = `local` or `s3` (default: `local`)
- `UPLOADS_DIR` (optional; local storage path, recommended on Render: `/var/data/printlab/uploads`)
- `MAX_UPLOAD_MB` (default: `100`)
- `S3_BUCKET` (required when `STORAGE_PROVIDER=s3`)
- `S3_REGION` (required when `STORAGE_PROVIDER=s3`)
- `S3_ACCESS_KEY_ID` (optional if role-based auth is available)
- `S3_SECRET_ACCESS_KEY` (optional if role-based auth is available)
- `S3_ENDPOINT` (optional; use for Cloudflare R2 / MinIO / other S3-compatible providers)
- `S3_FORCE_PATH_STYLE` = `true|false` (optional)
- `S3_KEY_PREFIX` (default: `print-files`)

Cleanup and maintenance:
- `ENABLE_MAINTENANCE_JOBS` = `true|false` (default: `true`)
- `CLEANUP_INTERVAL_MINUTES` (default: `60`)
- `FILE_RETENTION_DAYS` (default: `45`)
- `CLEANUP_BATCH_SIZE` (default: `200`)

Optional:
- `JSON_LIMIT_KB` (default: `100`)

## Render Hosting Recommendations

For many uploaded files, use either:
- **S3-compatible storage** (durable object storage), or
- a **Render persistent disk** with `STORAGE_PROVIDER=local` and `UPLOADS_DIR=/var/data/printlab/uploads`.

### Recommended setup
1. Keep app/web service on Render.
2. Keep PostgreSQL on Render (or Neon).
3. Set `STORAGE_PROVIDER=s3`.
4. Connect S3-compatible object storage (AWS S3 or Cloudflare R2).

### Why
- Render web service local filesystem can be ephemeral.
- Object storage is durable and scales better for hundreds/thousands of files.
- If you use local mode, a mounted persistent disk is required to keep files across deploys.

## Health Check

Health endpoint:
- `GET /healthz`

Use this as your Render health check path.

## Local Run

```bash
npm install
npm start
```

Open:
- Booking page: `http://localhost:3000`
- Admin dashboard: `http://localhost:3000/admin`

