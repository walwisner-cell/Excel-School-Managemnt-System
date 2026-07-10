const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// "Announcements" in the UI is the `notices` table under the hood; posted_at is
// exposed as created_at to match what the generic MODULES table renderer expects,
// and posted_by is set from the logged-in user rather than accepted from the client.
router.get('/announcements', authorize('communication.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT id, school_id, title, body, audience, posted_by, posted_at, posted_at AS created_at
     FROM notices WHERE school_id = $1 ORDER BY posted_at DESC`,
    [schoolId]
  );
  res.json(rows);
}));

router.post('/announcements', authorize('communication.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { title, body, audience } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO notices (school_id, title, body, audience, posted_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [schoolId, title, body, audience || 'all', req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'notices', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], created_at: rows[0].posted_at });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Direct messages between users ----
router.get('/messages', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE school_id = $1 AND (sender_id = $2 OR recipient_id = $2) ORDER BY sent_at DESC LIMIT 200`,
    [schoolId, req.user.id]
  );
  res.json(rows);
}));

router.post('/messages', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { recipient_id, subject, body } = req.body;
  if (!recipient_id || !body) return res.status(400).json({ error: 'recipient_id and body are required' });
  const { rows } = await pool.query(
    `INSERT INTO messages (school_id, sender_id, recipient_id, subject, body) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [schoolId, req.user.id, recipient_id, subject || null, body]
  );
  res.status(201).json(rows[0]);
}));

router.put('/messages/:id/read', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE messages SET read_at = now() WHERE id = $1 AND recipient_id = $2 AND school_id = $3 RETURNING *`,
    [req.params.id, req.user.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
}));

module.exports = router;
