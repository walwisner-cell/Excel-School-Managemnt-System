const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// Whole-school incident feed (used by the Health Records tab's "Recent Incidents" panel).
router.get('/incidents', authorize('health.view', 'health.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT hi.*, s.first_name, s.last_name FROM health_incidents hi JOIN students s ON s.id = hi.student_id
     WHERE hi.school_id = $1 ORDER BY hi.incident_date DESC LIMIT 200`,
    [schoolId]
  );
  res.json(rows);
}));

// Log an incident. Deliberately gated by health.incidents.log OR health.manage
// (not health.view) - a teacher who witnesses something should be able to log
// it without first being granted edit access to the student's full medical record.
router.post('/incidents', authorize('health.manage', 'health.incidents.log'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { student_id, description, action_taken, parent_notified, incident_date } = req.body;
  if (!student_id || !description) return res.status(400).json({ error: 'student_id and description are required' });
  const { rows } = await pool.query(
    `INSERT INTO health_incidents (school_id, student_id, incident_date, description, action_taken, parent_notified, reported_by)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6, $7) RETURNING *`,
    [schoolId, student_id, incident_date || null, description, action_taken || null, !!parent_notified, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

// One student's full health picture in one call: { record, vaccinations, incidents }
router.get('/students/:studentId', authorize('health.view', 'health.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: studentRows } = await pool.query('SELECT id FROM students WHERE id = $1 AND school_id = $2', [req.params.studentId, schoolId]);
  if (!studentRows[0]) return res.status(404).json({ error: 'Student not found' });

  const [record, vaccinations, incidents] = await Promise.all([
    pool.query('SELECT * FROM health_records WHERE student_id = $1 AND school_id = $2', [req.params.studentId, schoolId]),
    pool.query('SELECT * FROM vaccinations WHERE student_id = $1 AND school_id = $2 ORDER BY date_given DESC NULLS LAST', [req.params.studentId, schoolId]),
    pool.query('SELECT * FROM health_incidents WHERE student_id = $1 AND school_id = $2 ORDER BY incident_date DESC', [req.params.studentId, schoolId]),
  ]);
  res.json({ record: record.rows[0] || null, vaccinations: vaccinations.rows, incidents: incidents.rows });
}));

// Upsert the student's health record: { blood_group?, allergies?, conditions?, emergency_contact_name?, emergency_contact_phone? }
router.put('/students/:studentId', authorize('health.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: studentRows } = await pool.query('SELECT id FROM students WHERE id = $1 AND school_id = $2', [req.params.studentId, schoolId]);
  if (!studentRows[0]) return res.status(404).json({ error: 'Student not found' });

  const fields = ['blood_group', 'allergies', 'conditions', 'emergency_contact_name', 'emergency_contact_phone'];
  const values = fields.map((f) => (req.body[f] !== undefined ? req.body[f] : null));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM health_records WHERE student_id = $1 AND school_id = $2', [req.params.studentId, schoolId]);
    let result;
    if (existing[0]) {
      const setClause = fields.map((f, i) => `${f} = COALESCE($${i + 1}, ${f})`).join(', ');
      const { rows } = await client.query(
        `UPDATE health_records SET ${setClause}, updated_by = $${fields.length + 1}, updated_at = now()
         WHERE student_id = $${fields.length + 2} AND school_id = $${fields.length + 3} RETURNING *`,
        [...values, req.user.id, req.params.studentId, schoolId]
      );
      result = rows[0];
    } else {
      const { rows } = await client.query(
        `INSERT INTO health_records (school_id, student_id, blood_group, allergies, conditions, emergency_contact_name, emergency_contact_phone, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
        [schoolId, req.params.studentId, ...values, req.user.id]
      );
      result = rows[0];
    }
    await logAudit(client, {
      schoolId, tableName: 'health_records', recordId: result.id, action: existing[0] ? 'update' : 'create',
      changedBy: req.user.id, oldValues: existing[0] || null, newValues: result,
    });
    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Add a vaccination record (no dedicated UI form yet, kept available - see README).
router.post('/students/:studentId/vaccinations', authorize('health.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { vaccine_name, date_given, next_due_date } = req.body;
  if (!vaccine_name) return res.status(400).json({ error: 'vaccine_name is required' });
  const { rows: studentRows } = await pool.query('SELECT id FROM students WHERE id = $1 AND school_id = $2', [req.params.studentId, schoolId]);
  if (!studentRows[0]) return res.status(404).json({ error: 'Student not found' });
  const { rows } = await pool.query(
    `INSERT INTO vaccinations (school_id, student_id, vaccine_name, date_given, next_due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [schoolId, req.params.studentId, vaccine_name, date_given || null, next_due_date || null, req.user.id]
  );
  res.status(201).json(rows[0]);
}));

module.exports = router;
