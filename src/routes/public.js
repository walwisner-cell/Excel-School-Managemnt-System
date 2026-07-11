const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');

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

module.exports = router;
