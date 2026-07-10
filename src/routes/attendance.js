const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

router.get('/statuses', authorize('attendance.view', 'attendance.mark'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT * FROM attendance_statuses WHERE school_id = $1 ORDER BY id', [schoolId]);
  res.json(rows);
}));

// View attendance: ?class_id=&date=  or  ?student_id=&from=&to=
router.get('/', authorize('attendance.view', 'attendance.mark'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'sa.school_id = $1';
  let join = '';

  if (req.query.class_id && req.query.date) {
    join = 'JOIN students s ON s.id = sa.student_id';
    params.push(req.query.class_id, req.query.date);
    where += ` AND s.class_id = $${params.length - 1} AND sa.attendance_date = $${params.length}`;
  } else if (req.query.student_id) {
    params.push(req.query.student_id);
    where += ` AND sa.student_id = $${params.length}`;
    if (req.query.from) { params.push(req.query.from); where += ` AND sa.attendance_date >= $${params.length}`; }
    if (req.query.to) { params.push(req.query.to); where += ` AND sa.attendance_date <= $${params.length}`; }
  } else {
    return res.status(400).json({ error: 'Provide either (class_id and date) or student_id' });
  }

  const { rows } = await pool.query(
    `SELECT sa.*, st.code AS status_code, st.label AS status_label
     FROM student_attendance sa ${join} JOIN attendance_statuses st ON st.id = sa.status_id
     WHERE ${where} ORDER BY sa.attendance_date DESC`,
    params
  );
  res.json(rows);
}));

// Mark the whole roster (or a subset) at once: { attendance_date, entries: [{ student_id, status_code, remarks? }] }
// Upserts so re-submitting the same date corrects rather than duplicates.
router.post('/students/bulk', authorize('attendance.mark'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { attendance_date, entries } = req.body;
  if (!attendance_date || !Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: 'attendance_date and a non-empty entries array are required' });
  }

  const { rows: statusRows } = await pool.query('SELECT id, code FROM attendance_statuses WHERE school_id = $1', [schoolId]);
  const statusByCode = Object.fromEntries(statusRows.map((s) => [s.code, s.id]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const entry of entries) {
      const statusId = statusByCode[entry.status_code];
      if (!statusId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Unknown status_code '${entry.status_code}'` });
      }
      const { rows } = await client.query(
        `INSERT INTO student_attendance (school_id, student_id, attendance_date, status_id, remarks, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (student_id, attendance_date, period_number)
         DO UPDATE SET status_id = $4, remarks = $5, updated_by = $6, updated_at = now()
         RETURNING *`,
        [schoolId, entry.student_id, attendance_date, statusId, entry.remarks || null, req.user.id]
      );
      results.push(rows[0]);
    }
    await logAudit(client, {
      schoolId, tableName: 'student_attendance', recordId: null, action: 'create',
      changedBy: req.user.id, oldValues: null, newValues: { attendance_date, count: results.length },
    });
    await client.query('COMMIT');
    res.status(201).json({ saved: results.length, records: results });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
