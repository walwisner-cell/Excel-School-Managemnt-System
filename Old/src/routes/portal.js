const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(authorize('portal.view'));

// Every route below first verifies the requested student is actually one of the
// logged-in parent's children (via guardians.user_id -> student_guardians), so a
// parent can never view another family's data by guessing a student id.
async function assertOwnChild(schoolId, parentUserId, studentId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM student_guardians sg
     JOIN guardians g ON g.id = sg.guardian_id
     WHERE sg.student_id = $1 AND g.user_id = $2 AND g.school_id = $3`,
    [studentId, parentUserId, schoolId]
  );
  return rows.length > 0;
}

router.get('/children', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS class_name, sec.name AS section_name
     FROM students s
     JOIN student_guardians sg ON sg.student_id = s.id
     JOIN guardians g ON g.id = sg.guardian_id
     LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN sections sec ON sec.id = s.section_id
     WHERE g.user_id = $1 AND g.school_id = $2
     ORDER BY s.first_name`,
    [req.user.id, schoolId]
  );
  res.json(rows);
}));

router.get('/children/:studentId/attendance', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!(await assertOwnChild(schoolId, req.user.id, req.params.studentId))) {
    return res.status(403).json({ error: 'Not your child' });
  }
  const { rows } = await pool.query(
    `SELECT sa.attendance_date, ast.label AS status_label, ast.code AS status_code
     FROM student_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
     WHERE sa.student_id = $1 AND sa.period_number IS NULL
     ORDER BY sa.attendance_date DESC LIMIT 60`,
    [req.params.studentId]
  );
  res.json(rows);
}));

router.get('/children/:studentId/results', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!(await assertOwnChild(schoolId, req.user.id, req.params.studentId))) {
    return res.status(403).json({ error: 'Not your child' });
  }
  const { rows } = await pool.query(
    `SELECT e.name AS exam_name, sub.name AS subject_name, m.marks_obtained, m.is_absent, es.max_marks
     FROM marks m
     JOIN exam_subjects es ON es.id = m.exam_subject_id
     JOIN exams e ON e.id = es.exam_id
     JOIN subjects sub ON sub.id = es.subject_id
     WHERE m.student_id = $1
     ORDER BY e.created_at DESC, sub.name`,
    [req.params.studentId]
  );
  res.json(rows);
}));

router.get('/children/:studentId/invoices', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!(await assertOwnChild(schoolId, req.user.id, req.params.studentId))) {
    return res.status(403).json({ error: 'Not your child' });
  }
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE student_id = $1 AND school_id = $2 ORDER BY created_at DESC`,
    [req.params.studentId, schoolId]
  );
  res.json(rows);
}));

module.exports = router;
