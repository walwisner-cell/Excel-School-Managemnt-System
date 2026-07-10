const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

router.get('/', authorize('performance.view', 'performance.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'se.school_id = $1';
  if (req.query.staff_id) { params.push(req.query.staff_id); where += ` AND se.staff_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT se.*, s.first_name, s.last_name, u.email AS evaluated_by_email
     FROM staff_evaluations se
     JOIN staff s ON s.id = se.staff_id
     LEFT JOIN users u ON u.id = se.evaluated_by
     WHERE ${where} ORDER BY se.review_period_end DESC`,
    params
  );
  res.json(rows);
}));

// { staff_id, review_period_start, review_period_end, overall_rating, strengths?, areas_for_improvement? }
router.post('/', authorize('performance.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { staff_id, review_period_start, review_period_end, overall_rating, strengths, areas_for_improvement } = req.body;
  if (!staff_id || !review_period_start || !review_period_end || overall_rating == null) {
    return res.status(400).json({ error: 'staff_id, review_period_start, review_period_end, and overall_rating are required' });
  }
  if (Number(overall_rating) < 1 || Number(overall_rating) > 5) {
    return res.status(400).json({ error: 'overall_rating must be between 1 and 5' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO staff_evaluations (school_id, staff_id, review_period_start, review_period_end, overall_rating, strengths, areas_for_improvement, evaluated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [schoolId, staff_id, review_period_start, review_period_end, overall_rating, strengths || null, areas_for_improvement || null, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'staff_evaluations', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(
      `SELECT se.*, s.first_name, s.last_name, u.email AS evaluated_by_email
       FROM staff_evaluations se JOIN staff s ON s.id = se.staff_id LEFT JOIN users u ON u.id = se.evaluated_by WHERE se.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// The staff member themselves acknowledges having read the review.
router.post('/:id/acknowledge', authorize('performance.view', 'performance.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE staff_evaluations SET acknowledged_at = now() WHERE id = $1 AND school_id = $2 RETURNING *`,
    [req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Evaluation not found' });
  res.json(rows[0]);
}));

module.exports = router;
