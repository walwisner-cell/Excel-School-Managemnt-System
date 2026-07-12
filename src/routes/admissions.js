const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextAdmissionNo } = require('../utils/admissionNumbers');
const { getOrCreateCurrentAcademicYear } = require('../utils/academicYear');
const { upload, recordDocument, listDocuments, getDocumentOr404, absolutePath, deleteDocument } = require('../utils/documents');

const router = express.Router();
router.use(authenticate);

const INQUIRY_SELECT = `
  SELECT ai.*, c.name AS class_applying_name, ay.name AS academic_year_applying_name,
         s.id AS enrolled_student_id, s.admission_no AS enrolled_admission_no
  FROM admission_inquiries ai
  LEFT JOIN classes c ON c.id = ai.class_applying_id
  LEFT JOIN academic_years ay ON ay.id = ai.academic_year_applying_id
  LEFT JOIN students s ON s.admission_inquiry_id = ai.id`;

const INTAKE_FIELDS = [
  'first_name', 'last_name', 'dob', 'gender', 'nationality', 'address', 'city', 'county', 'country',
  'previous_school', 'class_applying_id', 'academic_year_applying_id', 'parent_name', 'relation',
  'phone', 'email', 'emergency_contact_name', 'emergency_contact_phone', 'referral_source', 'notes',
];

router.get('/inquiries', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'ai.school_id = $1';
  if (req.query.status) { params.push(req.query.status); where += ` AND ai.status = $${params.length}`; }
  // Typeahead search by name, per spec ("user begins typing... matching applicants displayed").
  if (req.query.q) {
    params.push(`%${req.query.q}%`);
    where += ` AND (ai.first_name ILIKE $${params.length} OR ai.last_name ILIKE $${params.length})`;
  }
  const { rows } = await pool.query(`${INQUIRY_SELECT} WHERE ${where} ORDER BY ai.created_at DESC`, params);
  res.json(rows);
}));

router.get('/inquiries/:id', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(`${INQUIRY_SELECT} WHERE ai.id = $1 AND ai.school_id = $2`, [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Inquiry not found' });
  const { rows: appRows } = await pool.query('SELECT * FROM admission_applications WHERE inquiry_id = $1', [req.params.id]);
  const documents = await listDocuments('admission_inquiry', req.params.id, schoolId);
  res.json({ ...rows[0], application: appRows[0] || null, documents });
}));

// inquiry_no is always server-generated (INQ-{year}-{5 digit id}).
// Accepts either the full field set below, or a legacy { student_name } convenience
// field (split into first/last) for callers that haven't been updated to the fuller form.
router.post('/inquiries', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  let { first_name, last_name } = req.body;
  if (!first_name && !last_name && req.body.student_name) {
    const parts = req.body.student_name.trim().split(/\s+/);
    first_name = parts[0];
    last_name = parts.slice(1).join(' ') || parts[0];
  }
  if (!first_name || !last_name) return res.status(400).json({ error: 'first_name and last_name (or student_name) are required' });

  const values = INTAKE_FIELDS.map((f) => (f === 'first_name' ? first_name : f === 'last_name' ? last_name : req.body[f] ?? null));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cols = INTAKE_FIELDS.join(', ');
    const placeholders = INTAKE_FIELDS.map((_, i) => `$${i + 2}`).join(', ');
    const { rows } = await client.query(
      `INSERT INTO admission_inquiries (school_id, inquiry_no, ${cols}) VALUES ($1, 'PENDING', ${placeholders}) RETURNING *`,
      [schoolId, ...values]
    );
    const inquiryNo = `INQ-${new Date().getFullYear()}-${String(rows[0].id).padStart(5, '0')}`;
    await client.query('UPDATE admission_inquiries SET inquiry_no = $1 WHERE id = $2', [inquiryNo, rows[0].id]);
    await client.query('INSERT INTO admission_applications (inquiry_id) VALUES ($1)', [rows[0].id]);
    await logAudit(client, { schoolId, tableName: 'admission_inquiries', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: { ...rows[0], inquiry_no: inquiryNo } });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${INQUIRY_SELECT} WHERE ai.id = $1`, [rows[0].id]);
    res.status(201).json({ ...full[0], documents: [] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/inquiries/:id', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const setCols = INTAKE_FIELDS.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => req.body[f]);
  values.push(req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE admission_inquiries SET ${setClause}, updated_at = now() WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Inquiry not found' });
  res.json(rows[0]);
}));

// Exact status vocabulary from spec: inquiry, application_received, interview_scheduled,
// accepted, waitlisted, rejected, enrolled. 'enrolled' can only be reached via /enroll
// below (it also creates the student record), not by setting status directly.
const VALID_STATUSES = ['inquiry', 'application_received', 'interview_scheduled', 'accepted', 'waitlisted', 'rejected'];
router.put('/inquiries/:id/status', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  const { rows } = await pool.query(
    `UPDATE admission_inquiries SET status = $1, updated_at = now() WHERE id = $2 AND school_id = $3 RETURNING *`,
    [status, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Inquiry not found' });
  res.json(rows[0]);
}));

// Dedicated "Approve Admission" action from spec - shorthand for status -> accepted,
// separate from /enroll (approval makes the applicant *eligible* for enrollment;
// enrollment is the later, distinct step that actually creates the student record).
router.post('/inquiries/:id/approve', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE admission_inquiries SET status = 'accepted', updated_at = now() WHERE id = $1 AND school_id = $2 AND status != 'enrolled' RETURNING *`,
    [req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Inquiry not found, or already enrolled' });
  res.json(rows[0]);
}));

router.put('/inquiries/:id/application', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: inquiryRows } = await pool.query('SELECT id FROM admission_inquiries WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!inquiryRows[0]) return res.status(404).json({ error: 'Inquiry not found' });
  const fields = ['entrance_test_score', 'interview_notes', 'seat_allotted'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => req.body[f]);
  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE admission_applications SET ${setClause}, updated_at = now() WHERE inquiry_id = $${values.length} RETURNING *`,
    values
  );
  res.json(rows[0]);
}));

// ---- Documents ("Upload Documents" from spec) ----
router.get('/inquiries/:id/documents', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  res.json(await listDocuments('admission_inquiry', req.params.id, schoolId));
}));

router.post('/inquiries/:id/documents', authorize('admissions.manage'), asyncHandler(async (req, res, next) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT id FROM admission_inquiries WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Inquiry not found' });
  req.uploadContext = { schoolId, ownerType: 'admission_inquiry', ownerId: req.params.id };
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'file is required (multipart form field "file")' });
    try {
      const doc = await recordDocument(pool, {
        schoolId, ownerType: 'admission_inquiry', ownerId: req.params.id,
        label: req.body.label, file: req.file, uploadedBy: req.user.id,
      });
      res.status(201).json(doc);
    } catch (e) { next(e); }
  });
}));

router.get('/documents/:docId/download', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const doc = await getDocumentOr404(req.params.docId, schoolId);
  if (!doc || doc.owner_type !== 'admission_inquiry') return res.status(404).json({ error: 'Document not found' });
  res.download(absolutePath(doc), doc.original_name);
}));

router.delete('/documents/:docId', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const doc = await getDocumentOr404(req.params.docId, schoolId);
  if (!doc || doc.owner_type !== 'admission_inquiry') return res.status(404).json({ error: 'Document not found' });
  await deleteDocument(doc, req.user.id);
  res.status(204).send();
}));

// Approve + enroll in one atomic step, transferring every captured field onto the new
// student record (per spec: "the system should automatically transfer all admission
// details into the student's profile"). class_id/section_id/academic_year_id can be
// overridden in the body; otherwise they default to what was captured at inquiry time.
router.post('/inquiries/:id/enroll', authorize('admissions.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: inquiryRows } = await client.query('SELECT * FROM admission_inquiries WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!inquiryRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Inquiry not found' }); }
    const inquiry = inquiryRows[0];
    if (inquiry.status === 'enrolled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This inquiry has already been enrolled' });
    }
    const classId = req.body.class_id || inquiry.class_applying_id;
    if (!classId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No class_id given and the inquiry has no class_applying_id on file - pass class_id explicitly' });
    }
    const academicYearId = req.body.academic_year_id || inquiry.academic_year_applying_id || (await getOrCreateCurrentAcademicYear(client, schoolId)).id;

    const admissionNo = await nextAdmissionNo(client, schoolId);
    const { rows: studentRows } = await client.query(
      `INSERT INTO students (
         school_id, admission_no, first_name, last_name, dob, gender, nationality, previous_school,
         source, admission_inquiry_id, academic_year_id, class_id, section_id, health_info, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admissions', $9, $10, $11, $12, $13, $14, $14) RETURNING *`,
      [
        schoolId, admissionNo, inquiry.first_name, inquiry.last_name, inquiry.dob, inquiry.gender,
        inquiry.nationality, inquiry.previous_school, inquiry.id, academicYearId, classId,
        req.body.section_id || null, inquiry.notes, req.user.id,
      ]
    );

    // Carry the primary contact captured at inquiry time into a guardian record too,
    // so it's not lost - the fuller multi-guardian relationship can be refined later
    // from the Guardians tab.
    if (inquiry.parent_name) {
      const { rows: guardianRows } = await client.query(
        `INSERT INTO guardians (school_id, name, relation, phone, email, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
        [schoolId, inquiry.parent_name, inquiry.relation, inquiry.phone, inquiry.email, req.user.id]
      );
      await client.query(
        `INSERT INTO student_guardians (student_id, guardian_id, relation, is_primary) VALUES ($1, $2, $3, true)`,
        [studentRows[0].id, guardianRows[0].id, inquiry.relation]
      );
    }

    // Carry admission-time documents over to the student's document list (same files,
    // re-pointed rather than duplicated on disk - only the DB row's owner changes).
    await client.query(
      `UPDATE documents SET owner_type = 'student', owner_id = $1 WHERE owner_type = 'admission_inquiry' AND owner_id = $2`,
      [studentRows[0].id, req.params.id]
    );

    await client.query(
      `INSERT INTO student_class_history (school_id, student_id, academic_year_id, class_id, section_id, status, recorded_by)
       VALUES ($1, $2, $3, $4, $5, 'enrolled', $6)`,
      [schoolId, studentRows[0].id, academicYearId, classId, req.body.section_id || null, req.user.id]
    );

    await client.query('UPDATE admission_applications SET enrolled_student_id = $1, seat_allotted = true, updated_at = now() WHERE inquiry_id = $2', [studentRows[0].id, req.params.id]);
    await client.query(`UPDATE admission_inquiries SET status = 'enrolled', updated_at = now() WHERE id = $1`, [req.params.id]);

    await logAudit(client, { schoolId, tableName: 'students', recordId: studentRows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: { ...studentRows[0], enrolled_from_inquiry: req.params.id } });
    await client.query('COMMIT');
    const { rows: withClass } = await pool.query(
      `SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1`,
      [studentRows[0].id]
    );
    res.status(201).json(withClass[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
