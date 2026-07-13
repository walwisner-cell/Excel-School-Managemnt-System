const express = require('express');
const PDFDocument = require('pdfkit');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(authorize('transcripts.view'));

async function buildTranscript(schoolId, studentId) {
  const { rows: studentRows } = await pool.query('SELECT * FROM students WHERE id = $1 AND school_id = $2', [studentId, schoolId]);
  if (!studentRows[0]) return null;
  const student = studentRows[0];

  const { rows: markRows } = await pool.query(
    `SELECT ay.name AS academic_year_name, e.name AS exam_name, sub.name AS subject_name,
            m.marks_obtained, m.is_absent, es.max_marks, gb.letter_grade, gb.grade_point
     FROM marks m
     JOIN exam_subjects es ON es.id = m.exam_subject_id
     JOIN exams e ON e.id = es.exam_id
     JOIN academic_years ay ON ay.id = e.academic_year_id
     JOIN subjects sub ON sub.id = es.subject_id
     LEFT JOIN grade_bands gb ON gb.grading_scale_id = m.grading_scale_id
       AND m.marks_obtained IS NOT NULL AND es.max_marks > 0
       AND (m.marks_obtained / es.max_marks * 100) BETWEEN gb.min_percent AND gb.max_percent
     WHERE m.student_id = $1
     ORDER BY ay.start_date, e.created_at, sub.name`,
    [studentId]
  );

  const byAcademicYear = {};
  const gradePoints = [];
  for (const row of markRows) {
    byAcademicYear[row.academic_year_name] ||= {};
    byAcademicYear[row.academic_year_name][row.exam_name] ||= [];
    byAcademicYear[row.academic_year_name][row.exam_name].push({
      subject_name: row.subject_name,
      marks_obtained: row.marks_obtained,
      max_marks: row.max_marks,
      is_absent: row.is_absent,
      letter_grade: row.letter_grade,
    });
    if (row.grade_point != null) gradePoints.push(Number(row.grade_point));
  }
  const cumulativeGpa = gradePoints.length
    ? Math.round((gradePoints.reduce((a, b) => a + b, 0) / gradePoints.length) * 100) / 100
    : null;

  return {
    student: { name: `${student.first_name} ${student.last_name}`, admission_no: student.admission_no },
    cumulative_gpa: cumulativeGpa,
    by_academic_year: byAcademicYear,
  };
}

router.get('/students/:id(\\d+)', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const data = await buildTranscript(schoolId, req.params.id);
  if (!data) return res.status(404).json({ error: 'Student not found' });
  res.json(data);
}));

router.get('/students/:id.pdf', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const data = await buildTranscript(schoolId, req.params.id);
  if (!data) return res.status(404).json({ error: 'Student not found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="transcript-${data.student.admission_no}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#8f2430').text('Academic Transcript');
  doc.moveDown(0.3);
  doc.fontSize(12).font('Helvetica').fillColor('#1a1416').text(`${data.student.name}  (Admission No: ${data.student.admission_no})`);
  if (data.cumulative_gpa !== null) {
    doc.fontSize(11).fillColor('#5b4d4f').text(`Cumulative GPA: ${data.cumulative_gpa}`);
  }
  doc.moveDown(0.8);

  for (const [yearName, exams] of Object.entries(data.by_academic_year)) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor('#8f6a12').text(yearName);
    doc.moveDown(0.2);
    for (const [examName, subjects] of Object.entries(exams)) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1416').text(examName);
      doc.fontSize(10).font('Helvetica');
      subjects.forEach((s) => {
        const score = s.is_absent ? 'Absent' : `${s.marks_obtained ?? '-'} / ${s.max_marks}`;
        doc.fillColor('#5b4d4f').text(`  ${s.subject_name}: ${score}${s.letter_grade ? ` (${s.letter_grade})` : ''}`);
      });
      doc.moveDown(0.3);
    }
    doc.moveDown(0.4);
  }
  if (!Object.keys(data.by_academic_year).length) {
    doc.fontSize(11).fillColor('#5b4d4f').text('No exam results on file yet.');
  }
  doc.end();
}));

module.exports = router;
