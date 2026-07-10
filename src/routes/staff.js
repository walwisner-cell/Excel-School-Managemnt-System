const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextNumber } = require('../utils/numberSequence');

const router = express.Router();
router.use(authenticate);

router.get('/', authorize('staff.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'school_id = $1';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where += ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR employee_no ILIKE $${params.length})`;
  }
  const { rows } = await pool.query(`SELECT * FROM staff WHERE ${where} ORDER BY last_name, first_name`, params);
  res.json(rows);
}));

router.get('/:id', authorize('staff.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  res.json(rows[0]);
}));

// { first_name, last_name, designation?, email?, phone? } - employee_no is
// server-generated (EMP-{year}-{seq}), same pattern as student admission numbers.
router.post('/', authorize('staff.create'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { first_name, last_name, designation, department, hire_date, salary_basic, phone, email } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'first_name and last_name are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const employeeNo = await nextNumber(client, schoolId, 'staff', { prefix: 'EMP', digits: 5 });
    const { rows } = await client.query(
      `INSERT INTO staff (school_id, employee_no, first_name, last_name, designation, department, hire_date, salary_basic, phone, email, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING *`,
      [schoolId, employeeNo, first_name, last_name, designation || null, department || null, hire_date || null, salary_basic || null, phone || null, email || null, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'staff', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', authorize('staff.update'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const fields = ['first_name', 'last_name', 'designation', 'department', 'hire_date', 'salary_basic', 'phone', 'email', 'status'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => req.body[f]);
  values.push(req.user.id, req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE staff SET ${setClause}, updated_by = $${values.length - 2}, updated_at = now()
     WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  res.json(rows[0]);
}));

router.delete('/:id', authorize('staff.delete'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE staff SET status = 'inactive', updated_by = $1, updated_at = now() WHERE id = $2 AND school_id = $3 RETURNING *`,
    [req.user.id, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  res.json(rows[0]);
}));

module.exports = router;
