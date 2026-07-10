const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// The schools table has no school_id column - it IS the tenant list - so this
// module can't use the generic crudRouter (which assumes tenant scoping) and is
// restricted to super_admin instead.
router.use(authorize('schools.manage'));

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM schools ORDER BY name');
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM schools WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'School not found' });
  res.json(rows[0]);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, code, address, phone, email } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO schools (name, code, address, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, code, address || null, phone || null, email || null]
    );
    await logAudit(client, { schoolId: rows[0].id, tableName: 'schools', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const fields = ['name', 'code', 'address', 'phone', 'email', 'status'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM schools WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'School not found' });
    }
    const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = setCols.map((f) => req.body[f]);
    values.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE schools SET ${setClause}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values
    );
    await logAudit(client, { schoolId: rows[0].id, tableName: 'schools', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: rows[0] });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
