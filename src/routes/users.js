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

// ---- Granular per-user permissions: view/edit overrides on top of role defaults ----

// Every permission that exists in the system, for building a "manage permissions"
// checkbox UI. Not school-scoped - permissions themselves are global definitions.
router.get('/permissions/catalog', authorize('users.manage'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT key, description FROM permissions ORDER BY key');
  res.json(rows);
}));

// Shows one user's role defaults, their explicit overrides, and the resulting
// effective permission set, so the UI can render "granted by role" vs "customized".
router.get('/:id/permissions', authorize('users.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: userRows } = await pool.query(
    `SELECT u.id, u.role_id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.school_id = $2`,
    [req.params.id, schoolId]
  );
  if (!userRows[0]) return res.status(404).json({ error: 'User not found' });

  const [allPerms, rolePerms, overrides] = await Promise.all([
    pool.query('SELECT key, description FROM permissions ORDER BY key'),
    pool.query('SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1', [userRows[0].role_id]),
    pool.query('SELECT p.key, upo.granted FROM user_permission_overrides upo JOIN permissions p ON p.id = upo.permission_id WHERE upo.user_id = $1', [req.params.id]),
  ]);
  const roleKeySet = new Set(rolePerms.rows.map((r) => r.key));
  const overrideByKey = Object.fromEntries(overrides.rows.map((r) => [r.key, r.granted]));

  const effective = allPerms.rows.map((p) => ({
    key: p.key,
    description: p.description,
    grantedByRole: roleKeySet.has(p.key),
    override: p.key in overrideByKey ? overrideByKey[p.key] : null,
    effective: p.key in overrideByKey ? overrideByKey[p.key] : roleKeySet.has(p.key),
  }));

  res.json({ roleName: userRows[0].role_name, permissions: effective });
}));

// { overrides: [{ permission_key, granted }] } - replaces ALL of this user's overrides
// with exactly this set (an empty array clears all customization, reverting them to
// their role's plain defaults). Applies on the user's very next request - see the
// comment in src/middleware/auth.js for why no re-login is needed.
router.put('/:id/permissions', authorize('users.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { overrides } = req.body;
  if (!Array.isArray(overrides)) return res.status(400).json({ error: 'overrides must be an array' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: userRows } = await client.query('SELECT id FROM users WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!userRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    await client.query('DELETE FROM user_permission_overrides WHERE user_id = $1', [req.params.id]);
    for (const o of overrides) {
      const { rows: permRows } = await client.query('SELECT id FROM permissions WHERE key = $1', [o.permission_key]);
      if (!permRows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Unknown permission '${o.permission_key}'` });
      }
      await client.query(
        `INSERT INTO user_permission_overrides (user_id, permission_id, granted, created_by) VALUES ($1, $2, $3, $4)`,
        [req.params.id, permRows[0].id, !!o.granted, req.user.id]
      );
    }
    await logAudit(client, {
      schoolId, tableName: 'user_permission_overrides', recordId: req.params.id, action: 'update',
      changedBy: req.user.id, oldValues: null, newValues: { overrides },
    });
    await client.query('COMMIT');
    res.json({ saved: overrides.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
