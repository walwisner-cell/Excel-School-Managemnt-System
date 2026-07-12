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

// Consolidated "Staff Profile" view, mirroring the student profile: everything
// about one staff member in one call - core info, teaching assignments,
// attendance summary, performance evaluations, and leave history.
router.get('/:id/profile', authorize('staff.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: staffRows } = await pool.query('SELECT * FROM staff WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!staffRows[0]) return res.status(404).json({ error: 'Staff member not found' });

  const [assignments, attendance, evaluations, leave] = await Promise.all([
    pool.query(
      `SELECT tsc.*, sub.name AS subject_name, c.name AS class_name, sec.name AS section_name
       FROM teacher_subject_class tsc JOIN subjects sub ON sub.id = tsc.subject_id JOIN classes c ON c.id = tsc.class_id
       LEFT JOIN sections sec ON sec.id = tsc.section_id
       WHERE tsc.staff_id = $1 AND tsc.school_id = $2`,
      [req.params.id, schoolId]
    ),
    pool.query(
      `SELECT ast.counts_present, COUNT(*) AS count FROM staff_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
       WHERE sa.staff_id = $1 GROUP BY ast.counts_present`,
      [req.params.id]
    ),
    pool.query('SELECT * FROM staff_evaluations WHERE staff_id = $1 AND school_id = $2 ORDER BY review_period_end DESC', [req.params.id, schoolId]),
    pool.query(`SELECT * FROM leave_requests WHERE applicant_type = 'staff' AND applicant_id = $1 AND school_id = $2 ORDER BY from_date DESC`, [req.params.id, schoolId]),
  ]);

  const attendanceSummary = Object.fromEntries(attendance.rows.map((r) => [r.counts_present ? 'present' : 'absent', Number(r.count)]));

  res.json({
    staff: staffRows[0],
    teachingAssignments: assignments.rows,
    attendanceSummary,
    evaluations: evaluations.rows,
    leaveRequests: leave.rows,
  });
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM staff WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Staff member not found' });
    }
    const { rows } = await client.query(
      `UPDATE staff SET status = 'inactive', updated_by = $1, updated_at = now() WHERE id = $2 AND school_id = $3 RETURNING *`,
      [req.user.id, req.params.id, schoolId]
    );
    await logAudit(client, { schoolId, tableName: 'staff', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: rows[0] });
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
