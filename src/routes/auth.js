const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate } = require('../middleware/auth');
const { getEffectivePermissions } = require('../utils/permissions');

const router = express.Router();

function signToken(user, roleName) {
  return jwt.sign(
    { sub: user.id, schoolId: user.school_id, roleId: user.role_id, roleName },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function publicUser(user, roleName, permissions) {
  return {
    id: user.id,
    schoolId: user.school_id,
    username: user.username,
    email: user.email,
    roleName,
    permissions,
  };
}

// POST /api/auth/login  { email, password, school_code? }
// school_code identifies the tenant (matches schools.code, e.g. "DEMO01"); leave it
// blank for the super_admin account, which has school_id = NULL and no school_code.
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password, school_code } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  let schoolId = null;
  if (school_code) {
    const { rows: schoolRows } = await pool.query('SELECT id FROM schools WHERE code = $1', [school_code]);
    if (!schoolRows[0]) return res.status(401).json({ error: 'Unknown school code' });
    schoolId = schoolRows[0].id;
  }

  const params = [email];
  let where = 'email = $1';
  if (schoolId) {
    params.push(schoolId);
    where += ` AND school_id = $${params.length}`;
  } else {
    where += ' AND school_id IS NULL';
  }
  const { rows } = await pool.query(
    `SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`,
    params
  );
  const user = rows[0];
  if (!user || user.status !== 'active') {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const permissions = await getEffectivePermissions(pool, user.id, user.role_id);
  const token = signToken(user, user.role_name);
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  res.json({ token, user: publicUser(user, user.role_name, permissions) });
}));

// GET /api/auth/me - re-derives the profile from the token (does not trust client state)
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.school_id, u.username, u.email, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(rows[0], rows[0].role_name, req.user.permissions));
}));

// PUT /api/auth/change-password - self-service, works for ANY authenticated user
// regardless of role/permissions, since changing your OWN password shouldn't
// require an admin permission - just proof you know the current one.
router.put('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'current_password and new_password are required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const matches = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!matches) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [newHash, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
