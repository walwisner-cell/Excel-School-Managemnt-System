require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));
// Two separate static sites share this server:
//   public/site -> the public marketing website, served at "/"
//   public/app  -> the school-management SPA (everything built so far), served at "/app"
// Both are single-file-per-page apps (no client-side URL routing), so a plain
// express.static mount per folder is all that's needed - no catch-all fallback route.
const noCacheHtml = {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  },
};
app.use('/app', express.static(path.join(__dirname, 'public/app'), noCacheHtml));
app.use(express.static(path.join(__dirname, 'public/site'), noCacheHtml));

// ---- API routes (must all be registered BEFORE the 404 catch-all below) ----
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/schools', require('./src/routes/schools'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/academics', require('./src/routes/academics'));
app.use('/api/students', require('./src/routes/students'));
app.use('/api/guardians', require('./src/routes/guardians'));
app.use('/api/staff', require('./src/routes/staff'));
app.use('/api/admissions', require('./src/routes/admissions'));
app.use('/api/attendance', require('./src/routes/attendance'));
app.use('/api/leave', require('./src/routes/leave'));
app.use('/api/gallery', require('./src/routes/gallery'));
app.use('/api/site-content', require('./src/routes/site-content'));
app.use('/api/audit', require('./src/routes/audit'));
app.use('/api/discipline', require('./src/routes/discipline'));
app.use('/api/exams', require('./src/routes/exams'));
app.use('/api/fees', require('./src/routes/fees'));
app.use('/api/communication', require('./src/routes/communication'));
app.use('/api/reports', require('./src/routes/reports'));
app.use('/api/library', require('./src/routes/library'));
app.use('/api/transport', require('./src/routes/transport'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/health-records', require('./src/routes/health'));
app.use('/api/events', require('./src/routes/events'));
app.use('/api/portal', require('./src/routes/portal'));
app.use('/api/expenses', require('./src/routes/expenses'));
app.use('/api/performance', require('./src/routes/performance'));
app.use('/api/id-cards', require('./src/routes/idcards'));
app.use('/api/transcripts', require('./src/routes/transcripts'));
app.use('/api/public', require('./src/routes/public'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ---- 404 catch-all (must be last) ----
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  // A streaming response (PDF/file generation) may have already sent headers
  // before something failed partway through - trying to send a second JSON
  // response at that point throws its own crash. Just end the connection instead.
  if (res.headersSent) return req.socket.destroy();
  // A generic, friendly fallback for a raw database CHECK-constraint violation
  // that reached here without a route-specific message (e.g. a future date of
  // birth, or an end date before a start date) - every route's catch block
  // just does `throw err`, and this is what actually turns that into something
  // a person can read instead of a raw Postgres error leaking to the screen.
  if (err.code === '23514') {
    return res.status(400).json({ error: 'One of the values provided isn\'t valid - check for things like a date of birth in the future, or an end date before a start date' });
  }
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`School Management System API running on http://localhost:${PORT}`);
});
