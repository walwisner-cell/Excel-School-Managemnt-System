const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

router.use('/', buildCrudRouter({
  table: 'guardians',
  fields: ['user_id', 'name', 'relation', 'phone', 'email', 'address', 'occupation'],
  requiredOnCreate: ['name'],
  viewPermission: 'guardians.manage',
  managePermission: 'guardians.manage',
  searchFields: ['name', 'email', 'phone'],
  orderBy: 'name',
}));

// Link a guardian to a student: { student_id, relation?, is_primary? }
// This is what makes GET /portal/children work for that guardian's user_id (if set).
router.post('/:id/link-student', authorize('guardians.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { student_id, relation, is_primary } = req.body;
  if (!student_id) return res.status(400).json({ error: 'student_id is required' });

  const { rows: guardianRows } = await pool.query('SELECT id FROM guardians WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!guardianRows[0]) return res.status(404).json({ error: 'Guardian not found' });
  const { rows: studentRows } = await pool.query('SELECT id FROM students WHERE id = $1 AND school_id = $2', [student_id, schoolId]);
  if (!studentRows[0]) return res.status(404).json({ error: 'Student not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO student_guardians (student_id, guardian_id, relation, is_primary) VALUES ($1, $2, $3, $4)
       ON CONFLICT (student_id, guardian_id) DO UPDATE SET relation = $3, is_primary = $4 RETURNING *`,
      [student_id, req.params.id, relation || null, !!is_primary]
    );
    await logAudit(client, { schoolId, tableName: 'student_guardians', recordId: null, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/:id/link-student/:studentId', authorize('guardians.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `DELETE FROM student_guardians sg USING guardians g
     WHERE sg.guardian_id = $1 AND sg.student_id = $2 AND sg.guardian_id = g.id AND g.school_id = $3
     RETURNING sg.student_id, sg.guardian_id, sg.relation, sg.is_primary`,
    [req.params.id, req.params.studentId, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Link not found' });
  await logAudit(pool, { schoolId, tableName: 'student_guardians', recordId: req.params.studentId, action: 'delete', changedBy: req.user.id, oldValues: rows[0], newValues: null }).catch(() => {});
  res.status(204).send();
}));

// All students linked to this guardian.
router.get('/:id/students', authorize('guardians.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT s.*, sg.relation, sg.is_primary FROM student_guardians sg
     JOIN students s ON s.id = sg.student_id
     JOIN guardians g ON g.id = sg.guardian_id
     WHERE sg.guardian_id = $1 AND g.school_id = $2`,
    [req.params.id, schoolId]
  );
  res.json(rows);
}));

module.exports = router;
