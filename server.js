require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const { initDB } = require('./db');
const { startMaintenanceJobs } = require('./maintenance');
const { apiLimiter } = require('./middleware/rateLimit');
const { getStorageSummary } = require('./storage');
const bookingsRouter = require('./routes/bookings');
const printersRouter = require('./routes/printers');
const slotsRouter = require('./routes/slots');
const cncRouter = require('./routes/cnc');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const jsonLimitKb = Math.max(50, Number(process.env.JSON_LIMIT_KB || 100));

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

if (process.env.NODE_ENV !== 'production') {
  app.use(cors());
}
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: `${jsonLimitKb}kb` }));
app.use('/api', apiLimiter);
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.use('/api/bookings', bookingsRouter);
app.use('/api/printers', printersRouter);
app.use('/api/slots', slotsRouter);
app.use('/api/cnc', cncRouter);
app.use('/api/admin', adminRouter);

// End of term T1 2026 — all student-facing booking pages show the closure notice.
// Restore original route handlers at start of next term.
const endOfTermPage = (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'end-of-term-notice.html'));
};

app.get('/', endOfTermPage);
app.get('/laser', endOfTermPage);
app.get('/windtunnel', endOfTermPage);
app.get('/cnc', endOfTermPage);

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

initDB().then(() => {
  const storage = getStorageSummary();
  console.log(`Storage provider: ${storage.provider} (max upload ${storage.maxUploadMb} MB, dir: ${storage.uploadsDir})`);
  startMaintenanceJobs();
  app.listen(PORT, () => {
    console.log(`MECH PrintLab server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
