const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

router.get('/', authorize('users.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.status, u.last_login_at, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.school_id = $1 ORDER BY u.username`,
    [schoolId]
  );
  res.json(rows);
}));

// { email, password, role_name } - username is derived from the email's local part
// (deduplicated with a numeric suffix if it collides) since the UI never asks for one.
router.post('/', authorize('users.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { email, password, role_name } = req.body;
  if (!email || !password || !role_name) return res.status(400).json({ error: 'email, password, and role_name are required' });
  const { rows: roleRows } = await pool.query('SELECT id FROM roles WHERE name = $1', [role_name]);
  if (!roleRows[0]) return res.status(400).json({ error: `Unknown role '${role_name}'` });

  const base = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '') || 'user';
  const { rows: clashRows } = await pool.query(`SELECT username FROM users WHERE school_id = $1 AND username LIKE $2`, [schoolId, `${base}%`]);
  const taken = new Set(clashRows.map((r) => r.username));
  let username = base;
  let suffix = 1;
  while (taken.has(username)) { username = `${base}${suffix}`; suffix += 1; }

  const passwordHash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (school_id, role_id, username, email, password_hash, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id, username, email, status`,
      [schoolId, roleRows[0].id, username, email, passwordHash, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'users', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: { username, email, role_name } });
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], role_name });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists at this school' });
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', authorize('users.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const updates = [];
  const values = [];
  if (req.body.status) { values.push(req.body.status); updates.push(`status = $${values.length}`); }
  if (req.body.password) { values.push(await bcrypt.hash(req.body.password, 10)); updates.push(`password_hash = $${values.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.user.id, req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE users SET ${updates.join(', ')}, updated_by = $${values.length - 2}, updated_at = now()
     WHERE id = $${values.length - 1} AND school_id = $${values.length}
     RETURNING id, username, email, status`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}));

module.exports = router;
