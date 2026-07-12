const express = require('express');
const path = require('path');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { CONTENT_KEYS } = require('../utils/siteContentKeys');

const router = express.Router();

// Every endpoint here is intentionally unauthenticated - this is what the public
// marketing website calls. It resolves the school by its public `code` (e.g.
// "DEMO01") rather than by a logged-in user's session, and only ever returns
// data that's meant to be public (no financial figures, no student/staff records,
// no internal-only announcements).
async function resolveSchoolByCode(code) {
  if (!code) return null;
  const { rows } = await pool.query('SELECT id, code, name, address, phone, email FROM schools WHERE code = $1', [code]);
  return rows[0] || null;
}

router.get('/school-info', asyncHandler(async (req, res) => {
  const school = await resolveSchoolByCode(req.query.code);
  if (!school) return res.status(404).json({ error: 'Unknown school code' });
  res.json(school);
}));

// Serves the school's uploaded logo if one exists - the public site's JS checks
// for a 404 here and falls back to the generic crest icon when there isn't one.
router.get('/logo', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, logo_stored_name FROM schools WHERE code = $1', [req.query.code]);
  const school = rows[0];
  if (!school?.logo_stored_name) return res.status(404).json({ error: 'No logo uploaded' });
  res.sendFile(path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), String(school.id), 'logo', school.logo_stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Logo file not found' });
  });
}));

// Published, upcoming-first events - same is_published flag used by the staff Events
// screen, so publishing an event there is what makes it show up here.
router.get('/events', asyncHandler(async (req, res) => {
  const school = await resolveSchoolByCode(req.query.code);
  if (!school) return res.status(404).json({ error: 'Unknown school code' });
  const { rows } = await pool.query(
    `SELECT title, description, event_type, event_date, location
     FROM events WHERE school_id = $1 AND is_published = true
     ORDER BY event_date DESC NULLS LAST LIMIT 20`,
    [school.id]
  );
  res.json(rows);
}));

// Announcements explicitly marked is_public by staff - most internal announcements
// stay internal by default; someone has to deliberately check "public" for it to
// show up here.
router.get('/announcements', asyncHandler(async (req, res) => {
  const school = await resolveSchoolByCode(req.query.code);
  if (!school) return res.status(404).json({ error: 'Unknown school code' });
  const { rows } = await pool.query(
    `SELECT title, body, posted_at FROM notices WHERE school_id = $1 AND is_public = true ORDER BY posted_at DESC LIMIT 20`,
    [school.id]
  );
  res.json(rows);
}));

// Public gallery: only ever returns/serves photos explicitly marked is_public -
// an unpublished photo stays completely unreachable here, even if someone guesses
// its id.
router.get('/gallery', asyncHandler(async (req, res) => {
  const school = await resolveSchoolByCode(req.query.code);
  if (!school) return res.status(404).json({ error: 'Unknown school code' });
  const { rows } = await pool.query(
    `SELECT id, caption FROM gallery_photos WHERE school_id = $1 AND is_public = true ORDER BY sort_order, uploaded_at DESC`,
    [school.id]
  );
  res.json(rows);
}));

// Which photo (if any) is currently featured as the hero background for each
// public page - only considers public photos, so an unpublished one can never
// end up shown as a hero image by accident.
router.get('/featured-images', asyncHandler(async (req, res) => {
  const school = await resolveSchoolByCode(req.query.code);
  if (!school) return res.status(404).json({ error: 'Unknown school code' });
  const { rows } = await pool.query(
    `SELECT id, placement FROM gallery_photos WHERE school_id = $1 AND is_public = true AND placement IS NOT NULL`,
    [school.id]
  );
  const result = {};
  rows.forEach((r) => { result[r.placement] = r.id; });
  res.json(result);
}));

router.get('/gallery/:id/file', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gallery_photos WHERE id = $1 AND is_public = true', [req.params.id]);
  const photo = rows[0];
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  const filePath = path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), String(photo.school_id), 'gallery', photo.stored_name);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Photo file not found' });
  });
}));

// Returns EVERY content key with either the school's saved customization or the
// built-in default - the public pages never have to know which one they got,
// they just always have text to show.
router.get('/site-content', asyncHandler(async (req, res) => {
  const school = await resolveSchoolByCode(req.query.code);
  if (!school) return res.status(404).json({ error: 'Unknown school code' });
  const { rows } = await pool.query('SELECT content_key, content_value FROM site_content WHERE school_id = $1', [school.id]);
  const saved = Object.fromEntries(rows.map((r) => [r.content_key, r.content_value]));
  const result = {};
  CONTENT_KEYS.forEach(([key, , fallback]) => { result[key] = (saved[key] && saved[key].trim()) || fallback; });
  res.json(result);
}));

module.exports = router;
