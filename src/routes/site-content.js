const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { CONTENT_KEYS } = require('../utils/siteContentKeys');

const router = express.Router();
router.use(authenticate);
router.use(authorize('site_content.manage'));

router.get('/', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT content_key, content_value FROM site_content WHERE school_id = $1', [schoolId]);
  const saved = Object.fromEntries(rows.map((r) => [r.content_key, r.content_value]));
  res.json(CONTENT_KEYS.map(([key, label, fallback]) => ({
    key, label, value: saved[key] ?? '', placeholder: fallback,
  })));
}));

// { "home_hero_headline": "...", "about_mission": "...", ... } - only keys present
// in the body get touched; sending an empty string clears a customization and
// reverts that field to its default.
router.put('/', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const validKeys = new Set(CONTENT_KEYS.map(([key]) => key));
  const entries = Object.entries(req.body).filter(([key]) => validKeys.has(key));
  if (!entries.length) return res.status(400).json({ error: 'No recognized content keys provided' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO site_content (school_id, content_key, content_value, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (school_id, content_key) DO UPDATE SET content_value = $3, updated_by = $4, updated_at = now()`,
        [schoolId, key, value, req.user.id]
      );
    }
    await logAudit(client, { schoolId, tableName: 'site_content', recordId: null, action: 'update', changedBy: req.user.id, oldValues: null, newValues: req.body });
    await client.query('COMMIT');
    res.json({ saved: entries.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
