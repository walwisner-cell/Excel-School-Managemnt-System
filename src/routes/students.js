const express = require('express');
const PDFDocument = require('pdfkit');
const { Document, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, Packer, WidthType, BorderStyle } = require('docx');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextAdmissionNo } = require('../utils/admissionNumbers');
const { getOrCreateCurrentAcademicYear } = require('../utils/academicYear');
const { upload, recordDocument, listDocuments, getDocumentOr404, absolutePath, deleteDocument } = require('../utils/documents');

const router = express.Router();
router.use(authenticate);

const SELECT_WITH_CLASS = `
  SELECT s.*, c.name AS class_name, sec.name AS section_name, ay.name AS academic_year_name
  FROM students s
  LEFT JOIN classes c ON c.id = s.class_id
  LEFT JOIN sections sec ON sec.id = s.section_id
  LEFT JOIN academic_years ay ON ay.id = s.academic_year_id`;

router.get('/', authorize('students.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 's.school_id = $1';
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where += ` AND (s.first_name ILIKE $${params.length} OR s.last_name ILIKE $${params.length} OR s.admission_no ILIKE $${params.length})`;
  }
  if (req.query.class_id) { params.push(req.query.class_id); where += ` AND s.class_id = $${params.length}`; }
  if (req.query.section_id) { params.push(req.query.section_id); where += ` AND s.section_id = $${params.length}`; }
  if (req.query.status) { params.push(req.query.status); where += ` AND s.status = $${params.length}`; }
  const { rows } = await pool.query(`${SELECT_WITH_CLASS} WHERE ${where} ORDER BY s.last_name, s.first_name`, params);
  res.json(rows);
}));

router.get('/:id', authorize('students.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(`${SELECT_WITH_CLASS} WHERE s.id = $1 AND s.school_id = $2`, [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Student not found' });
  const { rows: guardianRows } = await pool.query(
    `SELECT g.*, sg.relation, sg.is_primary FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = $1`,
    [req.params.id]
  );
  res.json({ ...rows[0], guardians: guardianRows });
}));

// Consolidated "Student Record" view, per spec: everything about a student in one
// call - core profile, guardians, medical summary, class history, attendance summary,
// recent academic results, fee status, and uploaded documents.
router.get('/:id/profile', authorize('students.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: studentRows } = await pool.query(`${SELECT_WITH_CLASS} WHERE s.id = $1 AND s.school_id = $2`, [req.params.id, schoolId]);
  if (!studentRows[0]) return res.status(404).json({ error: 'Student not found' });

  const [guardians, health, classHistory, attendance, results, invoices, documents] = await Promise.all([
    pool.query(`SELECT g.*, sg.relation, sg.is_primary FROM student_guardians sg JOIN guardians g ON g.id = sg.guardian_id WHERE sg.student_id = $1`, [req.params.id]),
    pool.query('SELECT * FROM health_records WHERE student_id = $1 AND school_id = $2', [req.params.id, schoolId]),
    pool.query(
      `SELECT sch.*, ay.name AS academic_year_name, c.name AS class_name
       FROM student_class_history sch LEFT JOIN academic_years ay ON ay.id = sch.academic_year_id LEFT JOIN classes c ON c.id = sch.class_id
       WHERE sch.student_id = $1 ORDER BY ay.start_date DESC NULLS LAST, sch.recorded_at DESC`,
      [req.params.id]
    ),
    pool.query(
      `SELECT ast.counts_present, COUNT(*) AS count FROM student_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
       WHERE sa.student_id = $1 AND sa.period_number IS NULL GROUP BY ast.counts_present`,
      [req.params.id]
    ),
    pool.query(
      `SELECT e.name AS exam_name, sub.name AS subject_name, m.marks_obtained, m.is_absent, es.max_marks
       FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN exams e ON e.id = es.exam_id JOIN subjects sub ON sub.id = es.subject_id
       WHERE m.student_id = $1 ORDER BY e.created_at DESC LIMIT 20`,
      [req.params.id]
    ),
    pool.query('SELECT id, invoice_no, total_amount, amount_paid, status, due_date FROM invoices WHERE student_id = $1 AND school_id = $2 ORDER BY created_at DESC', [req.params.id, schoolId]),
    listDocuments('student', req.params.id, schoolId),
  ]);

  const attendanceSummary = Object.fromEntries(attendance.rows.map((r) => [r.counts_present ? 'present' : 'absent', Number(r.count)]));
  const outstandingBalance = invoices.rows.reduce((sum, inv) => sum + (Number(inv.total_amount) - Number(inv.amount_paid)), 0);

  res.json({
    student: studentRows[0],
    guardians: guardians.rows,
    health: health.rows[0] || null,
    classHistory: classHistory.rows,
    attendanceSummary,
    recentResults: results.rows,
    invoices: invoices.rows,
    outstandingBalance,
    documents,
  });
}));

router.get('/:id/class-history', authorize('students.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: studentRows } = await pool.query('SELECT id FROM students WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!studentRows[0]) return res.status(404).json({ error: 'Student not found' });
  const { rows } = await pool.query(
    `SELECT sch.*, ay.name AS academic_year_name, c.name AS class_name
     FROM student_class_history sch LEFT JOIN academic_years ay ON ay.id = sch.academic_year_id LEFT JOIN classes c ON c.id = sch.class_id
     WHERE sch.student_id = $1 ORDER BY ay.start_date DESC NULLS LAST, sch.recorded_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

// Direct/walk-in creation - covers Transfer Student, Returning Student, and Direct
// Registration from the spec's "source" dropdown (the fourth option, "Admissions",
// only ever happens via POST /admissions/inquiries/:id/enroll, which sets it itself).
router.post('/', authorize('students.create'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { first_name, last_name, dob, gender, nationality, previous_school, source, class_id, section_id, academic_year_id, health_info, photo_url } = req.body;
  if (!first_name || !last_name) return res.status(400).json({ error: 'first_name and last_name are required' });
  const finalSource = ['transfer_student', 'returning_student', 'direct_registration'].includes(source) ? source : 'direct_registration';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admissionNo = await nextAdmissionNo(client, schoolId);
    const resolvedAcademicYearId = academic_year_id || (await getOrCreateCurrentAcademicYear(client, schoolId)).id;
    const { rows } = await client.query(
      `INSERT INTO students (school_id, admission_no, first_name, last_name, dob, gender, nationality, previous_school, source, class_id, section_id, academic_year_id, health_info, photo_url, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) RETURNING *`,
      [schoolId, admissionNo, first_name, last_name, dob || null, gender || null, nationality || null, previous_school || null,
       finalSource, class_id || null, section_id || null, resolvedAcademicYearId, health_info || null, photo_url || null, req.user.id]
    );
    if (rows[0].class_id) {
      await client.query(
        `INSERT INTO student_class_history (school_id, student_id, academic_year_id, class_id, section_id, status, recorded_by)
         VALUES ($1, $2, $3, $4, $5, 'enrolled', $6)`,
        [schoolId, rows[0].id, rows[0].academic_year_id, rows[0].class_id, rows[0].section_id, req.user.id]
      );
    }
    await logAudit(client, { schoolId, tableName: 'students', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: withClass } = await pool.query(`${SELECT_WITH_CLASS} WHERE s.id = $1`, [rows[0].id]);
    res.status(201).json(withClass[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', authorize('students.update'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const fields = ['first_name', 'last_name', 'dob', 'gender', 'nationality', 'previous_school', 'class_id', 'section_id', 'academic_year_id', 'health_info', 'photo_url', 'status'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM students WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found' });
    }
    const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = setCols.map((f) => req.body[f]);
    values.push(req.user.id, req.params.id, schoolId);
    const { rows } = await client.query(
      `UPDATE students SET ${setClause}, updated_by = $${values.length - 2}, updated_at = now()
       WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *`,
      values
    );
    // Moving class/year outside the /promote bulk flow still gets logged to history.
    if (('class_id' in req.body || 'academic_year_id' in req.body) && (rows[0].class_id !== existing[0].class_id || rows[0].academic_year_id !== existing[0].academic_year_id)) {
      await client.query(
        `INSERT INTO student_class_history (school_id, student_id, academic_year_id, class_id, section_id, status, recorded_by)
         VALUES ($1, $2, $3, $4, $5, 'transferred', $6)`,
        [schoolId, rows[0].id, rows[0].academic_year_id, rows[0].class_id, rows[0].section_id, req.user.id]
      );
    }
    await logAudit(client, { schoolId, tableName: 'students', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: withClass } = await pool.query(`${SELECT_WITH_CLASS} WHERE s.id = $1`, [rows[0].id]);
    res.json(withClass[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/:id', authorize('students.delete'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM students WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found' });
    }
    const { rows } = await client.query(
      `UPDATE students SET status = 'withdrawn', updated_by = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(client, { schoolId, tableName: 'students', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: rows[0] });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Bulk promotion, with full history logging and an optional dry-run preview so an
// admin can "review and confirm before applying" per spec.
// Body: { student_ids, to_class_id, to_section_id?, to_academic_year_id?, status?, preview? }
router.post('/promote', authorize('students.update'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { student_ids, to_class_id, to_section_id, to_academic_year_id, status, preview } = req.body;
  if (!Array.isArray(student_ids) || !student_ids.length || !to_class_id) {
    return res.status(400).json({ error: 'student_ids (array) and to_class_id are required' });
  }
  const historyStatus = ['promoted', 'repeated', 'transferred'].includes(status) ? status : 'promoted';

  if (preview) {
    const { rows } = await pool.query(
      `SELECT s.id, s.first_name, s.last_name, s.admission_no, c.name AS current_class_name
       FROM students s LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.id = ANY($1::int[]) AND s.school_id = $2`,
      [student_ids, schoolId]
    );
    const { rows: targetClass } = await pool.query('SELECT name FROM classes WHERE id = $1 AND school_id = $2', [to_class_id, schoolId]);
    return res.json({ preview: true, movingTo: targetClass[0]?.name || null, students: rows });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE students SET class_id = $1, section_id = $2, academic_year_id = COALESCE($3, academic_year_id), updated_by = $4, updated_at = now()
       WHERE id = ANY($5::int[]) AND school_id = $6 RETURNING id, first_name, last_name, class_id, section_id, academic_year_id`,
      [to_class_id, to_section_id || null, to_academic_year_id || null, req.user.id, student_ids, schoolId]
    );
    for (const student of rows) {
      await client.query(
        `INSERT INTO student_class_history (school_id, student_id, academic_year_id, class_id, section_id, status, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [schoolId, student.id, student.academic_year_id, student.class_id, student.section_id, historyStatus, req.user.id]
      );
    }
    await logAudit(client, {
      schoolId, tableName: 'students', recordId: null, action: 'update',
      changedBy: req.user.id, oldValues: { student_ids }, newValues: { to_class_id, to_section_id, to_academic_year_id, count: rows.length },
    });
    await client.query('COMMIT');
    res.json({ promoted: rows.length, students: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Documents ----
router.get('/:id/documents', authorize('students.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  res.json(await listDocuments('student', req.params.id, schoolId));
}));

router.post('/:id/documents', authorize('students.update'), asyncHandler(async (req, res, next) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT id FROM students WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Student not found' });
  req.uploadContext = { schoolId, ownerType: 'student', ownerId: req.params.id };
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'file is required (multipart form field "file")' });
    try {
      const doc = await recordDocument(pool, {
        schoolId, ownerType: 'student', ownerId: req.params.id,
        label: req.body.label, file: req.file, uploadedBy: req.user.id,
      });
      res.status(201).json(doc);
    } catch (e) { next(e); }
  });
}));

router.get('/documents/:docId/download', authorize('students.view'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const doc = await getDocumentOr404(req.params.docId, schoolId);
  if (!doc || doc.owner_type !== 'student') return res.status(404).json({ error: 'Document not found' });
  res.download(absolutePath(doc), doc.original_name);
}));

router.delete('/documents/:docId', authorize('students.update'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const doc = await getDocumentOr404(req.params.docId, schoolId);
  if (!doc || doc.owner_type !== 'student') return res.status(404).json({ error: 'Document not found' });
  await deleteDocument(doc, req.user.id);
  res.status(204).send();
}));

// Shared by both the .pdf and .docx admission letter endpoints below, so the
// two formats can never quietly show different data for the same student.
async function getStudentForLetter(studentId, schoolId) {
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS class_name, ay.name AS academic_year_name, sch.name AS school_name, sch.address AS school_address,
            sch.phone AS school_phone, sch.email AS school_email, ai.parent_name
     FROM students s
     LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN academic_years ay ON ay.id = s.academic_year_id
     LEFT JOIN admission_inquiries ai ON ai.id = s.admission_inquiry_id
     JOIN schools sch ON sch.id = s.school_id
     WHERE s.id = $1 AND s.school_id = $2`,
    [studentId, schoolId]
  );
  return rows[0] || null;
}

// Formal admission letter, generated once a student is enrolled. Pulls the
// parent's name from the original admission inquiry when the student came
// through that flow (the common case); falls back to a generic salutation for
// students registered directly.
router.get('/:id/admission-letter.pdf', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const s = await getStudentForLetter(req.params.id, schoolId);
  if (!s) return res.status(404).json({ error: 'Student not found' });

  const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="admission-letter-${s.admission_no}.pdf"`);
  doc.pipe(res);

  // Letterhead
  doc.fillColor('#8f2430').fontSize(20).font('Helvetica-Bold').text(s.school_name, { align: 'center' });
  doc.moveDown(0.2);
  doc.fillColor('#5b4d4f').fontSize(9).font('Helvetica')
    .text([s.school_address, s.school_phone, s.school_email].filter(Boolean).join('  •  '), { align: 'center' });
  doc.moveDown(0.3);
  doc.strokeColor('#c9a227').lineWidth(2).moveTo(60, doc.y).lineTo(552, doc.y).stroke();
  doc.moveDown(1.5);

  doc.fillColor('#1a1416').fontSize(11).font('Helvetica')
    .text(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }));
  doc.moveDown(1);

  doc.font('Helvetica-Bold').text(s.parent_name ? `Dear ${s.parent_name},` : 'Dear Parent/Guardian,');
  doc.moveDown(1);

  doc.font('Helvetica').fontSize(11).text(
    `We are pleased to confirm that ${s.first_name} ${s.last_name} has been admitted to ${s.school_name} for the ${s.academic_year_name || 'current'} academic year. We look forward to welcoming ${s.first_name} into our school community.`,
    { align: 'justify', lineGap: 4 }
  );
  doc.moveDown(1);

  doc.font('Helvetica-Bold').text('Enrollment Details');
  doc.moveDown(0.3);
  const detailRows = [
    ['Student Name', `${s.first_name} ${s.last_name}`],
    ['Admission Number', s.admission_no],
    ['Class', s.class_name || 'To be assigned'],
    ['Academic Year', s.academic_year_name || '-'],
    ['Admission Date', s.admission_date ? new Date(s.admission_date).toLocaleDateString() : '-'],
  ];
  detailRows.forEach(([label, value]) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#5b4d4f').text(label + ':', 60, doc.y, { continued: true, width: 160 });
    doc.font('Helvetica').fillColor('#1a1416').text('  ' + value);
  });
  doc.moveDown(1);

  doc.font('Helvetica').fontSize(11).text(
    'Please retain this letter as confirmation of enrollment. Our admissions team will be in touch with further details regarding orientation, required documents, and the first day of school.',
    { align: 'justify', lineGap: 4 }
  );
  doc.moveDown(2);

  doc.text('Sincerely,');
  doc.moveDown(2);
  doc.strokeColor('#1a1416').lineWidth(0.5).moveTo(60, doc.y).lineTo(220, doc.y).stroke();
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#5b4d4f').text('Admissions Office');
  doc.text(s.school_name);

  doc.end();
}));

// Same admission letter, as an editable Word document - useful when a school
// wants to tweak the wording for a specific family before sending it.
router.get('/:id/admission-letter.docx', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const s = await getStudentForLetter(req.params.id, schoolId);
  if (!s) return res.status(404).json({ error: 'Student not found' });

  const detailRows = [
    ['Student Name', `${s.first_name} ${s.last_name}`],
    ['Admission Number', s.admission_no],
    ['Class', s.class_name || 'To be assigned'],
    ['Academic Year', s.academic_year_name || '-'],
    ['Admission Date', s.admission_date ? new Date(s.admission_date).toLocaleDateString() : '-'],
  ];
  const cellBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: s.school_name, bold: true, size: 32, color: '16324F' })] }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: [s.school_address, s.school_phone, s.school_email].filter(Boolean).join('   •   '), size: 18, color: '545B6B' })],
        }),
        new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9A227' } } }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun({ text: s.parent_name ? `Dear ${s.parent_name},` : 'Dear Parent/Guardian,', bold: true })] }),
        new Paragraph({ text: '' }),
        new Paragraph({
          text: `We are pleased to confirm that ${s.first_name} ${s.last_name} has been admitted to ${s.school_name} for the ${s.academic_year_name || 'current'} academic year. We look forward to welcoming ${s.first_name} into our school community.`,
          alignment: AlignmentType.JUSTIFIED,
        }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun({ text: 'Enrollment Details', bold: true })] }),
        new Paragraph({ text: '' }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: detailRows.map(([label, value]) => new TableRow({
            children: [
              new TableCell({ borders: noBorders, width: { size: 35, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: label + ':', bold: true, color: '545B6B' })] })] }),
              new TableCell({ borders: noBorders, width: { size: 65, type: WidthType.PERCENTAGE }, children: [new Paragraph(String(value))] }),
            ],
          })),
        }),
        new Paragraph({ text: '' }),
        new Paragraph({
          text: 'Please retain this letter as confirmation of enrollment. Our admissions team will be in touch with further details regarding orientation, required documents, and the first day of school.',
          alignment: AlignmentType.JUSTIFIED,
        }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: 'Sincerely,' }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '_________________________' }),
        new Paragraph({ children: [new TextRun({ text: 'Admissions Office', color: '545B6B', size: 20 })] }),
        new Paragraph({ children: [new TextRun({ text: s.school_name, color: '545B6B', size: 20 })] }),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(document);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="admission-letter-${s.admission_no}.docx"`);
  res.send(buffer);
}));

module.exports = router;
