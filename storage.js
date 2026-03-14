const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'));
const tempUploadsDir = path.join(uploadsDir, 'tmp');
const defaultAllowedExtensions = ['.stl'];
const providerFromEnv = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
const maxUploadMb = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 100));
const maxUploadBytes = Math.floor(maxUploadMb * 1024 * 1024);

ensureDir(uploadsDir);
ensureDir(tempUploadsDir);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getFileExtension(fileName) {
  return path.extname(fileName || '').toLowerCase();
}

function sanitizeDownloadName(fileName) {
  const base = path.basename(fileName || 'print-file');
  const collapsed = base.replace(/\s+/g, ' ').trim();
  const safe = collapsed.replace(/[^a-zA-Z0-9._\-\s]/g, '_').slice(0, 180);
  return safe || 'print-file';
}

function isS3Configured() {
  return Boolean(process.env.S3_BUCKET && process.env.S3_REGION);
}

function hasExplicitS3Credentials() {
  return Boolean(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

function getS3ClientConfig() {
  const config = {
    region: process.env.S3_REGION
  };

  if (process.env.S3_ENDPOINT) {
    config.endpoint = process.env.S3_ENDPOINT;
    config.forcePathStyle = String(process.env.S3_FORCE_PATH_STYLE || 'false') === 'true';
  }

  if (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    };
  }

  return config;
}

const useS3Storage = providerFromEnv === 's3' && isS3Configured();
let s3Client = null;
if (useS3Storage) {
  s3Client = new S3Client(getS3ClientConfig());
  if (!hasExplicitS3Credentials()) {
    console.warn('[storage] S3 credentials were not provided explicitly. This only works if the runtime has an attached IAM role.');
  }
} else if (providerFromEnv === 's3') {
  console.warn('[storage] STORAGE_PROVIDER is set to s3 but S3 config is incomplete. Falling back to local storage.');
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[storage] Running in production with local file storage. Consider S3-compatible storage for durability.');
}

function getStorageProvider() {
  return useS3Storage ? 's3' : 'local';
}

function buildTempFileName(extension) {
  return `${Date.now()}-${crypto.randomUUID()}${extension}`;
}

function buildPermanentLocalFileName(extension) {
  return `${Date.now()}-${crypto.randomUUID()}${extension}`;
}

function buildS3ObjectKey(extension) {
  const prefix = (process.env.S3_KEY_PREFIX || 'print-files')
    .replace(/^\/+|\/+$/g, '');
  const datePart = new Date().toISOString().slice(0, 10);
  return `${prefix}/${datePart}/${Date.now()}-${crypto.randomUUID()}${extension}`;
}

async function readFirstBytes(filePath, count) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function validateFileSignature(filePath, extension) {
  if (extension === '.3mf') {
    // 3MF is a ZIP container and should start with the PK signature.
    const bytes = await readFirstBytes(filePath, 2);
    if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      const err = new Error('Uploaded .3mf file appears invalid (missing ZIP signature).');
      err.statusCode = 400;
      throw err;
    }
  }
}

function normalizeAllowedExtensions(extensions) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    return new Set(defaultAllowedExtensions);
  }
  const normalized = extensions
    .map((ext) => String(ext || '').trim().toLowerCase())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  if (normalized.length === 0) return new Set(defaultAllowedExtensions);
  return new Set(normalized);
}

function formatAllowedExtensions(extensionsSet) {
  return [...extensionsSet].join(', ');
}

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tempUploadsDir),
  filename: (_req, file, cb) => {
    const ext = getFileExtension(file.originalname);
    cb(null, buildTempFileName(ext));
  }
});

function createUploadMiddleware(fieldName = 'file', options = {}) {
  const allowAnyExtension = Boolean(options.allowAnyExtension);
  const allowedExtensions = normalizeAllowedExtensions(options.allowedExtensions);

  const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: maxUploadBytes },
    fileFilter: (_req, file, cb) => {
      if (allowAnyExtension) return cb(null, true);
      const ext = getFileExtension(file.originalname);
      if (!allowedExtensions.has(ext)) {
        return cb(new Error(`File type not allowed. Upload one of: ${formatAllowedExtensions(allowedExtensions)}.`));
      }
      return cb(null, true);
    }
  });

  return upload.single(fieldName);
}

function createUploadFieldsMiddleware(fields = [], options = {}) {
  const allowAnyExtension = Boolean(options.allowAnyExtension);
  const allowedExtensions = normalizeAllowedExtensions(options.allowedExtensions);

  const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: maxUploadBytes },
    fileFilter: (_req, file, cb) => {
      if (allowAnyExtension) return cb(null, true);
      const ext = getFileExtension(file.originalname);
      if (!allowedExtensions.has(ext)) {
        return cb(new Error(`File type not allowed. Upload one of: ${formatAllowedExtensions(allowedExtensions)}.`));
      }
      return cb(null, true);
    }
  });

  return upload.fields(fields);
}

async function removeTempFile(filePath) {
  if (!filePath) return;
  await fs.promises.unlink(filePath).catch(() => {});
}

async function persistUploadedFile(file) {
  if (!file || !file.path) {
    throw new Error('Missing uploaded file');
  }

  const extension = getFileExtension(file.originalname);
  const originalName = sanitizeDownloadName(file.originalname);
  const mimeType = file.mimetype || 'application/octet-stream';

  await validateFileSignature(file.path, extension);

  if (useS3Storage) {
    const objectKey = buildS3ObjectKey(extension);
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: objectKey,
        Body: fs.createReadStream(file.path),
        ContentType: mimeType
      }));
    } finally {
      await removeTempFile(file.path);
    }

    return {
      filePath: objectKey,
      storageProvider: 's3',
      fileOriginalName: originalName,
      fileSize: file.size,
      fileMime: mimeType
    };
  }

  const localName = buildPermanentLocalFileName(extension);
  const finalPath = path.join(uploadsDir, localName);
  try {
    await fs.promises.rename(file.path, finalPath);
  } catch (renameErr) {
    if (renameErr.code === 'EXDEV') {
      await fs.promises.copyFile(file.path, finalPath);
      await removeTempFile(file.path);
    } else {
      throw renameErr;
    }
  }

  return {
    filePath: localName,
    storageProvider: 'local',
    fileOriginalName: originalName,
    fileSize: file.size,
    fileMime: mimeType
  };
}

async function deleteStoredFile(filePath, storageProvider = 'local') {
  if (!filePath) return false;

  if (storageProvider === 's3') {
    if (!useS3Storage || !s3Client) return false;
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: filePath
      }));
      return true;
    } catch (err) {
      console.error('Failed to delete S3 object:', err);
      return false;
    }
  }

  const fullPath = path.join(uploadsDir, filePath);
  if (!fs.existsSync(fullPath)) return false;
  try {
    await fs.promises.unlink(fullPath);
    return true;
  } catch (err) {
    console.error('Failed to delete local file:', err);
    return false;
  }
}

async function sendStoredFile(res, fileMeta) {
  const filePath = (fileMeta && (fileMeta.filePath || fileMeta.file_path)) || null;
  const storageProvider = (fileMeta && (fileMeta.storageProvider || fileMeta.storage_provider)) || 'local';
  const fileOriginalName = (fileMeta && (fileMeta.fileOriginalName || fileMeta.file_original_name)) || null;
  const fileMime = (fileMeta && (fileMeta.fileMime || fileMeta.file_mime)) || null;

  if (!filePath) {
    const err = new Error('FILE_NOT_FOUND');
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }

  const downloadName = sanitizeDownloadName(fileOriginalName || path.basename(filePath));

  if (storageProvider === 's3') {
    if (!useS3Storage || !s3Client) {
      const err = new Error('S3_NOT_CONFIGURED');
      err.code = 'S3_NOT_CONFIGURED';
      throw err;
    }

    const result = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: filePath
    }));

    if (!result || !result.Body || typeof result.Body.pipe !== 'function') {
      const err = new Error('INVALID_FILE_STREAM');
      err.code = 'INVALID_FILE_STREAM';
      throw err;
    }

    res.setHeader('Content-Type', fileMime || result.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);
    result.Body.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream file' });
      } else {
        res.end();
      }
    });
    result.Body.pipe(res);
    return;
  }

  const fullPath = path.join(uploadsDir, filePath);
  if (!fs.existsSync(fullPath)) {
    console.error('[storage] local file missing for download', {
      uploadsDir,
      filePath,
      fullPath,
      cwd: process.cwd()
    });
    const err = new Error('FILE_NOT_FOUND');
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }

  res.download(fullPath, downloadName);
}

function getUploadsDir() {
  return uploadsDir;
}

function getStorageSummary() {
  return {
    provider: getStorageProvider(),
    maxUploadMb,
    uploadsDir
  };
}

module.exports = {
  createUploadMiddleware,
  createUploadFieldsMiddleware,
  persistUploadedFile,
  deleteStoredFile,
  sendStoredFile,
  getStorageProvider,
  getUploadsDir,
  getStorageSummary,
  removeTempFile
};
