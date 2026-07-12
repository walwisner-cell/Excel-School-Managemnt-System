const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// Whole-school recent history (mirrors the Health Records "Recent Incidents" pattern).
router.get('/', authorize('discipline.log', 'discipline.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'dr.school_id = $1';
  if (req.query.student_id) { params.push(req.query.student_id); where += ` AND dr.student_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT dr.*, s.first_name, s.last_name, u.email AS reported_by_email
     FROM disciplinary_records dr JOIN students s ON s.id = dr.student_id LEFT JOIN users u ON u.id = dr.reported_by
     WHERE ${where} ORDER BY dr.incident_date DESC LIMIT 200`,
    params
  );
  res.json(rows);
}));

const VALID_CATEGORIES = ['warning', 'detention', 'suspension', 'dismissal'];

// Log a plain incident (warning/detention) - deliberately gated by discipline.log
// OR discipline.manage, not just discipline.manage, so a teacher who witnesses
// something can record it without needing the authority to suspend or dismiss.
// Suspension/dismissal specifically go through the dedicated endpoints below
// instead, since those also change the student's actual enrollment status.
router.post('/', authorize('discipline.log', 'discipline.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { student_id, category, description, action_taken, incident_date } = req.body;
  if (!student_id || !description) return res.status(400).json({ error: 'student_id and description are required' });
  const finalCategory = category || 'warning';
  if (!['warning', 'detention'].includes(finalCategory)) {
    return res.status(400).json({ error: 'Use POST /discipline/:studentId/suspend or /dismiss for those categories - they also update enrollment status' });
  }
  const { rows } = await pool.query(
    `INSERT INTO disciplinary_records (school_id, student_id, incident_date, category, description, action_taken, reported_by)
     VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7) RETURNING *`,
    [schoolId, student_id, incident_date || null, finalCategory, description, action_taken || null, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

// { description, action_taken?, suspension_start, suspension_end }
// Suspends the student (status -> 'suspended') AND logs the disciplinary record
// in one atomic step, so the two can never end up out of sync.
router.post('/:studentId/suspend', authorize('discipline.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { description, action_taken, suspension_start, suspension_end } = req.body;
  if (!description || !suspension_start || !suspension_end) {
    return res.status(400).json({ error: 'description, suspension_start, and suspension_end are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM students WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.studentId, schoolId]);
    if (!existing[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Student not found' }); }
    const { rows: updated } = await client.query(
      `UPDATE students SET status = 'suspended', updated_by = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.studentId]
    );
    const { rows: record } = await client.query(
      `INSERT INTO disciplinary_records (school_id, student_id, category, description, action_taken, suspension_start, suspension_end, reported_by)
       VALUES ($1, $2, 'suspension', $3, $4, $5, $6, $7) RETURNING *`,
      [schoolId, req.params.studentId, description, action_taken || null, suspension_start, suspension_end, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'students', recordId: updated[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: updated[0] });
    await client.query('COMMIT');
    res.status(201).json({ student: updated[0], record: record[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Reinstates a suspended student back to active - deliberately its own action
// rather than something the generic student-status edit does silently, since a
// return from suspension is itself a meaningful, worth-recording event.
router.post('/:studentId/reinstate', authorize('discipline.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: existing } = await pool.query('SELECT * FROM students WHERE id = $1 AND school_id = $2', [req.params.studentId, schoolId]);
  if (!existing[0]) return res.status(404).json({ error: 'Student not found' });
  if (existing[0].status !== 'suspended') return res.status(409).json({ error: 'This student is not currently suspended' });
  const { rows } = await pool.query(
    `UPDATE students SET status = 'active', updated_by = $1, updated_at = now() WHERE id = $2 RETURNING *`,
    [req.user.id, req.params.studentId]
  );
  res.json(rows[0]);
}));

// { description, action_taken? } - permanent: status -> 'dismissed', distinct
// from a plain 'withdrawn' (parent's choice, moving away, etc.) since dismissal
// is specifically disciplinary in nature and should read that way in reports.
router.post('/:studentId/dismiss', authorize('discipline.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { description, action_taken } = req.body;
  if (!description) return res.status(400).json({ error: 'description is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM students WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.studentId, schoolId]);
    if (!existing[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Student not found' }); }
    const { rows: updated } = await client.query(
      `UPDATE students SET status = 'dismissed', updated_by = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.studentId]
    );
    const { rows: record } = await client.query(
      `INSERT INTO disciplinary_records (school_id, student_id, category, description, action_taken, reported_by)
       VALUES ($1, $2, 'dismissal', $3, $4, $5) RETURNING *`,
      [schoolId, req.params.studentId, description, action_taken || null, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'students', recordId: updated[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: updated[0] });
    await client.query('COMMIT');
    res.status(201).json({ student: updated[0], record: record[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', authorize('discipline.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const fields = ['category', 'description', 'action_taken', 'incident_date', 'suspension_start', 'suspension_end'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  if ('category' in req.body && !VALID_CATEGORIES.includes(req.body.category)) {
    return res.status(400).json({ error: `category must be one of ${VALID_CATEGORIES.join(', ')}` });
  }
  const { rows: existing } = await pool.query('SELECT * FROM disciplinary_records WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!existing[0]) return res.status(404).json({ error: 'Record not found' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => req.body[f]);
  values.push(req.user.id, req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE disciplinary_records SET ${setClause}, updated_by = $${values.length - 2}, updated_at = now()
     WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *`,
    values
  );
  await logAudit(pool, { schoolId, tableName: 'disciplinary_records', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: rows[0] }).catch(() => {});
  res.json(rows[0]);
}));

router.delete('/:id', authorize('discipline.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('DELETE FROM disciplinary_records WHERE id = $1 AND school_id = $2 RETURNING *', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
  await logAudit(pool, { schoolId, tableName: 'disciplinary_records', recordId: rows[0].id, action: 'delete', changedBy: req.user.id, oldValues: rows[0], newValues: null }).catch(() => {});
  res.status(204).send();
}));

module.exports = router;
