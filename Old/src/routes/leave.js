const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
router.use(authorize('leave.manage'));

// Joins in the applicant's name from whichever table applicant_type points to,
// since applicant_id alone isn't self-describing across two possible tables.
const LEAVE_SELECT = `
  SELECT lr.*,
         CASE WHEN lr.applicant_type = 'student' THEN s.first_name ELSE st.first_name END AS applicant_first_name,
         CASE WHEN lr.applicant_type = 'student' THEN s.last_name ELSE st.last_name END AS applicant_last_name
  FROM leave_requests lr
  LEFT JOIN students s ON s.id = lr.applicant_id AND lr.applicant_type = 'student'
  LEFT JOIN staff st ON st.id = lr.applicant_id AND lr.applicant_type = 'staff'`;

router.get('/', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'lr.school_id = $1';
  if (req.query.status) { params.push(req.query.status); where += ` AND lr.status = $${params.length}`; }
  if (req.query.applicant_type) { params.push(req.query.applicant_type); where += ` AND lr.applicant_type = $${params.length}`; }
  const { rows } = await pool.query(`${LEAVE_SELECT} WHERE ${where} ORDER BY lr.created_at DESC`, params);
  res.json(rows);
}));

// { applicant_type: 'student'|'staff', applicant_id, from_date, to_date, reason? }
router.post('/', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { applicant_type, applicant_id, from_date, to_date, reason } = req.body;
  if (!['student', 'staff'].includes(applicant_type)) return res.status(400).json({ error: "applicant_type must be 'student' or 'staff'" });
  if (!applicant_id || !from_date || !to_date) return res.status(400).json({ error: 'applicant_id, from_date, and to_date are required' });
  if (new Date(to_date) < new Date(from_date)) return res.status(400).json({ error: 'to_date must be on or after from_date' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO leave_requests (school_id, applicant_type, applicant_id, from_date, to_date, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [schoolId, applicant_type, applicant_id, from_date, to_date, reason || null]
    );
    await logAudit(client, { schoolId, tableName: 'leave_requests', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${LEAVE_SELECT} WHERE lr.id = $1`, [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:id/approve', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE leave_requests SET status = 'approved', approved_by = $1, updated_at = now()
     WHERE id = $2 AND school_id = $3 AND status = 'pending' RETURNING *`,
    [req.user.id, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Leave request not found, or not pending' });
  res.json(rows[0]);
}));

router.post('/:id/reject', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE leave_requests SET status = 'rejected', approved_by = $1, updated_at = now()
     WHERE id = $2 AND school_id = $3 AND status = 'pending' RETURNING *`,
    [req.user.id, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Leave request not found, or not pending' });
  res.json(rows[0]);
}));

module.exports = router;
