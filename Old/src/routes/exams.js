const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

router.use('/grading-scales', buildCrudRouter({
  table: 'grading_scales',
  fields: ['name', 'version', 'effective_from', 'is_active'],
  requiredOnCreate: ['name', 'effective_from'],
  viewPermission: 'exams.manage',
  managePermission: 'exams.manage',
  orderBy: 'name, version DESC',
}));

const { getOrCreateCurrentAcademicYear } = require('../utils/academicYear');

router.use(authenticate);

// GET /exams - exam_date is start_date under the alias the UI expects.
router.get('/', authorize('exams.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT *, start_date AS exam_date FROM exams WHERE school_id = $1 ORDER BY start_date DESC NULLS LAST, id DESC`,
    [schoolId]
  );
  res.json(rows);
}));

router.get('/:id', authorize('exams.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(`SELECT *, start_date AS exam_date FROM exams WHERE id = $1 AND school_id = $2`, [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Exam not found' });
  res.json(rows[0]);
}));

// { name, exam_date, class_name, exam_category?, term_id?, is_national_exam?, exam_body? }
// academic_year_id resolved automatically; class_name is stored as free text
// (pass class_id separately for the relational link). exam_category is for the
// school's own LOCAL exams (Class Test, Mid-Term, Promotion Exam, etc.) - most
// exams use this, not is_national_exam/exam_body, which is specifically for WAEC.
router.post('/', authorize('exams.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { name, exam_date, class_name, exam_category, class_id, term_id, exam_body } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  // The simple exam form only sends exam_body (e.g. "WAEC") - treat any non-empty
  // value as flagging this as a national exam, without requiring a separate checkbox.
  const isNationalExam = req.body.is_national_exam != null ? !!req.body.is_national_exam : !!(exam_body && exam_body.trim());

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const academicYear = await getOrCreateCurrentAcademicYear(client, schoolId);
    const { rows } = await client.query(
      `INSERT INTO exams (school_id, academic_year_id, term_id, name, exam_category, class_id, class_name, start_date, is_national_exam, exam_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [schoolId, academicYear.id, term_id || null, name, exam_category || null, class_id || null, class_name || null, exam_date || null, isNationalExam, exam_body || null]
    );
    await logAudit(client, { schoolId, tableName: 'exams', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], exam_date: rows[0].start_date });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', authorize('exams.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const bodyMap = { ...req.body, start_date: req.body.exam_date ?? req.body.start_date };
  const fields = ['name', 'exam_category', 'class_id', 'class_name', 'status', 'start_date', 'end_date', 'term_id', 'is_national_exam', 'exam_body'];
  const setCols = fields.filter((f) => f in bodyMap && bodyMap[f] !== undefined);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => bodyMap[f]);
  values.push(req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE exams SET ${setClause} WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *, start_date AS exam_date`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Exam not found' });
  res.json(rows[0]);
}));

// ---- Exam subjects (max/passing marks per subject) ----
router.post('/:examId/subjects', authorize('exams.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { subject_id, max_marks, passing_marks, exam_date } = req.body;
  if (!subject_id) return res.status(400).json({ error: 'subject_id is required' });
  const { rows: examRows } = await pool.query('SELECT id FROM exams WHERE id = $1 AND school_id = $2', [req.params.examId, schoolId]);
  if (!examRows[0]) return res.status(404).json({ error: 'Exam not found' });
  const { rows } = await pool.query(
    `INSERT INTO exam_subjects (exam_id, subject_id, max_marks, passing_marks, exam_date)
     VALUES ($1, $2, COALESCE($3, 100), COALESCE($4, 35), $5) RETURNING *`,
    [req.params.examId, subject_id, max_marks, passing_marks, exam_date || null]
  );
  res.status(201).json(rows[0]);
}));

router.get('/:examId/subjects', authorize('exams.manage', 'marks.enter', 'marks.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT es.*, sub.name AS subject_name FROM exam_subjects es
     JOIN subjects sub ON sub.id = es.subject_id JOIN exams e ON e.id = es.exam_id
     WHERE es.exam_id = $1 AND e.school_id = $2 ORDER BY sub.name`,
    [req.params.examId, schoolId]
  );
  res.json(rows);
}));

router.post('/grading-scales/:scaleId/bands', authorize('exams.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { min_percent, max_percent, letter_grade, grade_point } = req.body;
  if (min_percent == null || max_percent == null || !letter_grade) {
    return res.status(400).json({ error: 'min_percent, max_percent, and letter_grade are required' });
  }
  const { rows: scaleRows } = await pool.query('SELECT id FROM grading_scales WHERE id = $1 AND school_id = $2', [req.params.scaleId, schoolId]);
  if (!scaleRows[0]) return res.status(404).json({ error: 'Grading scale not found' });
  const { rows } = await pool.query(
    `INSERT INTO grade_bands (grading_scale_id, min_percent, max_percent, letter_grade, grade_point)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.params.scaleId, min_percent, max_percent, letter_grade, grade_point || null]
  );
  res.status(201).json(rows[0]);
}));

// Existing marks for one exam_subject, joined with student names - lets the marks
// entry screen show what's already been entered (and who's still missing) instead
// of only ever writing blind.
router.get('/exam-subjects/:examSubjectId/marks', authorize('marks.enter', 'marks.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: esRows } = await pool.query(
    `SELECT es.*, sub.name AS subject_name FROM exam_subjects es JOIN subjects sub ON sub.id = es.subject_id JOIN exams e ON e.id = es.exam_id WHERE es.id = $1 AND e.school_id = $2`,
    [req.params.examSubjectId, schoolId]
  );
  if (!esRows[0]) return res.status(404).json({ error: 'Exam subject not found' });
  const { rows } = await pool.query(
    `SELECT m.* FROM marks m WHERE m.exam_subject_id = $1`,
    [req.params.examSubjectId]
  );
  res.json({ examSubject: esRows[0], marks: rows });
}));


router.post('/exam-subjects/:examSubjectId/marks', authorize('marks.enter'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { grading_scale_id, entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries (array) is required' });

  const { rows: esRows } = await pool.query(
    `SELECT es.* FROM exam_subjects es JOIN exams e ON e.id = es.exam_id WHERE es.id = $1 AND e.school_id = $2`,
    [req.params.examSubjectId, schoolId]
  );
  if (!esRows[0]) return res.status(404).json({ error: 'Exam subject not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const entry of entries) {
      const { rows } = await client.query(
        `INSERT INTO marks (school_id, exam_subject_id, student_id, grading_scale_id, marks_obtained, is_absent, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (exam_subject_id, student_id)
         DO UPDATE SET marks_obtained = $5, is_absent = $6, grading_scale_id = $4, updated_by = $7, updated_at = now()
         RETURNING *`,
        [schoolId, req.params.examSubjectId, entry.student_id, grading_scale_id || null, entry.marks_obtained ?? null, !!entry.is_absent, req.user.id]
      );
      results.push(rows[0]);
    }
    await logAudit(client, { schoolId, tableName: 'marks', recordId: null, action: 'create', changedBy: req.user.id, oldValues: null, newValues: { exam_subject_id: req.params.examSubjectId, count: results.length } });
    await client.query('COMMIT');
    res.status(201).json({ saved: results.length, records: results });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.get('/:examId/report-card/:studentId', authorize('marks.view', 'marks.enter'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT sub.name AS subject_name, es.max_marks, es.passing_marks, m.marks_obtained, m.is_absent, gb.letter_grade, gb.grade_point
     FROM exam_subjects es
     JOIN exams e ON e.id = es.exam_id
     JOIN subjects sub ON sub.id = es.subject_id
     LEFT JOIN marks m ON m.exam_subject_id = es.id AND m.student_id = $3
     LEFT JOIN grade_bands gb ON gb.grading_scale_id = m.grading_scale_id
       AND m.marks_obtained IS NOT NULL AND es.max_marks > 0
       AND (m.marks_obtained / es.max_marks * 100) BETWEEN gb.min_percent AND gb.max_percent
     WHERE e.id = $1 AND e.school_id = $2 ORDER BY sub.name`,
    [req.params.examId, schoolId, req.params.studentId]
  );
  res.json(rows);
}));

module.exports = router;
