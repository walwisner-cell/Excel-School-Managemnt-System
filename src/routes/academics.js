const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// Registered before the generic CRUD mount below: an academic year cascades to
// terms, teaching assignments, exams, fee structures, invoices, AND payments -
// deleting one is catastrophic in a way none of this system's other deletes
// are. There's no safe partial-use case to detect here (unlike "still has
// active students" for a class), so this is blocked outright, not just left
// off the frontend - editing the year's name/dates is always the right fix.
router.delete('/academic-years/:id', authorize('academics.manage'), asyncHandler(async (req, res) => {
  res.status(409).json({ error: 'Academic years can\'t be deleted - they\'re referenced by exams, fees, invoices, and payments. Edit its name or dates instead if it was entered wrong.' });
}));

router.use('/academic-years', buildCrudRouter({
  table: 'academic_years',
  fields: ['name', 'start_date', 'end_date', 'is_current'],
  requiredOnCreate: ['name', 'start_date', 'end_date'],
  viewPermission: 'academics.manage',
  managePermission: 'academics.manage',
  orderBy: 'start_date DESC',
}));

// Registered before the generic CRUD mount below: exam_subjects references
// subjects with ON DELETE CASCADE, which would silently wipe out every mark
// ever recorded for this subject across every exam. This check stops that -
// edit the subject's name/code instead if it was entered wrong, rather than
// deleting and losing its exam history.
router.delete('/subjects/:id', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: used } = await pool.query(`SELECT id FROM exam_subjects WHERE subject_id = $1 LIMIT 1`, [req.params.id]);
  if (used[0]) {
    return res.status(409).json({ error: 'This subject has exam marks recorded against it and can\'t be deleted - edit its name instead if it was entered wrong' });
  }
  const { rows } = await pool.query('DELETE FROM subjects WHERE id = $1 AND school_id = $2 RETURNING *', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Subject not found' });
  await logAudit(pool, { schoolId, tableName: 'subjects', recordId: rows[0].id, action: 'delete', changedBy: req.user.id, oldValues: rows[0], newValues: null }).catch(() => {});
  res.status(204).send();
}));

router.use('/subjects', buildCrudRouter({
  table: 'subjects',
  fields: ['name', 'code', 'is_elective'],
  requiredOnCreate: ['name'],
  viewPermission: 'academics.manage',
  managePermission: 'academics.manage',
  searchFields: ['name', 'code'],
  orderBy: 'name',
}));

const { getOrCreateCurrentAcademicYear } = require('../utils/academicYear');

// GET /academics/classes - includes a computed student_count so the UI's
// "Students" column has something to show without a second round trip.
router.get('/classes', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT c.*, COUNT(s.id) AS student_count
     FROM classes c LEFT JOIN students s ON s.class_id = c.id AND s.status = 'active'
     WHERE c.school_id = $1
     GROUP BY c.id ORDER BY c.sort_order, c.name`,
    [schoolId]
  );
  res.json(rows.map((r) => ({ ...r, student_count: Number(r.student_count) })));
}));

router.get('/classes/:id', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT c.*, COUNT(s.id) AS student_count
     FROM classes c LEFT JOIN students s ON s.class_id = c.id AND s.status = 'active'
     WHERE c.id = $1 AND c.school_id = $2 GROUP BY c.id`,
    [req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  res.json({ ...rows[0], student_count: Number(rows[0].student_count) });
}));

// POST /academics/classes  { name, section?, teacher_name?, capacity? }
// academic_year_id is never sent by the UI - resolved automatically above.
router.post('/classes', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { name, section, teacher_name, capacity } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const academicYear = await getOrCreateCurrentAcademicYear(client, schoolId);
    const { rows } = await client.query(
      `INSERT INTO classes (school_id, academic_year_id, name, section, class_teacher, capacity)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [schoolId, academicYear.id, name, section || null, teacher_name || null, capacity || null]
    );
    await logAudit(client, { schoolId, tableName: 'classes', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], student_count: 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/classes/:id', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const fields = ['name', 'section', 'class_teacher', 'capacity', 'status', 'sort_order', 'academic_year_id'];
  const bodyMap = { ...req.body, class_teacher: req.body.teacher_name ?? req.body.class_teacher };
  const setCols = fields.filter((f) => f in bodyMap && bodyMap[f] !== undefined);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => bodyMap[f]);
  values.push(req.user.id, req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE classes SET ${setClause}, updated_by = $${values.length - 2}
     WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
}));

// Archive rather than delete, per spec's "Archive a class" action - keeps history
// intact for any student who was ever in this class.
router.post('/classes/:id/archive', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE classes SET status = 'archived', updated_by = $1 WHERE id = $2 AND school_id = $3 RETURNING *`,
    [req.user.id, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
}));

router.post('/classes/:id/reactivate', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE classes SET status = 'active', updated_by = $1 WHERE id = $2 AND school_id = $3 RETURNING *`,
    [req.user.id, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  res.json(rows[0]);
}));

// Hard delete is blocked if any student currently belongs to the class - archive
// (above) is the safe path for classes with history; this is only for mistakes.
router.delete('/classes/:id', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: activeStudents } = await pool.query(`SELECT id FROM students WHERE class_id = $1 AND status = 'active' LIMIT 1`, [req.params.id]);
  if (activeStudents[0]) {
    return res.status(409).json({ error: 'This class still has active students assigned - archive it instead, or move the students first' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM classes WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Class not found' });
    }
    await client.query('DELETE FROM classes WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
    await logAudit(client, { schoolId, tableName: 'classes', recordId: req.params.id, action: 'delete', changedBy: req.user.id, oldValues: existing[0], newValues: null });
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Sections: an optional, fully relational layer for schools that want real
// multi-section rosters (separate from the flat classes.section text field above). ----
router.get('/classes/:classId/sections', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: classRows } = await pool.query('SELECT id FROM classes WHERE id = $1 AND school_id = $2', [req.params.classId, schoolId]);
  if (!classRows[0]) return res.status(404).json({ error: 'Class not found' });
  const { rows } = await pool.query('SELECT * FROM sections WHERE class_id = $1 ORDER BY name', [req.params.classId]);
  res.json(rows);
}));

router.post('/classes/:classId/sections', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { name, capacity } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows: classRows } = await pool.query('SELECT id FROM classes WHERE id = $1 AND school_id = $2', [req.params.classId, schoolId]);
  if (!classRows[0]) return res.status(404).json({ error: 'Class not found' });
  const { rows } = await pool.query(
    `INSERT INTO sections (class_id, name, capacity) VALUES ($1, $2, $3) RETURNING *`,
    [req.params.classId, name, capacity || null]
  );
  res.status(201).json(rows[0]);
}));

// ---- Terms: editable per school (Liberian schools typically run 3 per year,
// but this isn't hardcoded - add/rename/date them however your school actually runs). ----
router.get('/terms', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 't.school_id = $1';
  if (req.query.academic_year_id) {
    params.push(req.query.academic_year_id);
    where += ` AND t.academic_year_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT t.*, ay.name AS academic_year_name FROM terms t JOIN academic_years ay ON ay.id = t.academic_year_id
     WHERE ${where} ORDER BY ay.start_date DESC, t.sort_order, t.id`,
    params
  );
  res.json(rows);
}));

// { name, academic_year_id?, start_date?, end_date?, sort_order? } - academic_year_id
// defaults to the school's current year, same convention as classes above.
router.post('/terms', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { name, start_date, end_date, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let academicYearId = req.body.academic_year_id;
    if (!academicYearId) {
      const academicYear = await getOrCreateCurrentAcademicYear(client, schoolId);
      academicYearId = academicYear.id;
    }
    const { rows } = await client.query(
      `INSERT INTO terms (school_id, academic_year_id, name, start_date, end_date, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), $7, $7) RETURNING *`,
      [schoolId, academicYearId, name, start_date || null, end_date || null, sort_order, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'terms', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'A term with this name already exists in that academic year' });
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/terms/:id', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const fields = ['name', 'start_date', 'end_date', 'sort_order'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => req.body[f]);
  values.push(req.user.id, req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE terms SET ${setClause}, updated_by = $${values.length - 2}
     WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Term not found' });
  res.json(rows[0]);
}));

// Marks this term current and un-marks any other term in the same academic year.
router.post('/terms/:id/set-current', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: termRows } = await client.query('SELECT * FROM terms WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!termRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Term not found' });
    }
    await client.query('UPDATE terms SET is_current = false WHERE academic_year_id = $1', [termRows[0].academic_year_id]);
    const { rows } = await client.query('UPDATE terms SET is_current = true, updated_by = $1 WHERE id = $2 RETURNING *', [req.user.id, req.params.id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/terms/:id', authorize('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM terms WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Term not found' });
    }
    await client.query('DELETE FROM terms WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
    await logAudit(client, { schoolId, tableName: 'terms', recordId: req.params.id, action: 'delete', changedBy: req.user.id, oldValues: existing[0], newValues: null });
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Teacher-Subject-Class assignment: "who teaches what to which class" ----
router.get('/teaching-assignments', authorize('timetable.manage', 'academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'tsc.school_id = $1';
  if (req.query.staff_id) { params.push(req.query.staff_id); where += ` AND tsc.staff_id = $${params.length}`; }
  if (req.query.class_id) { params.push(req.query.class_id); where += ` AND tsc.class_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT tsc.*, st.first_name, st.last_name, sub.name AS subject_name, c.name AS class_name, sec.name AS section_name
     FROM teacher_subject_class tsc
     JOIN staff st ON st.id = tsc.staff_id
     JOIN subjects sub ON sub.id = tsc.subject_id
     JOIN classes c ON c.id = tsc.class_id
     LEFT JOIN sections sec ON sec.id = tsc.section_id
     WHERE ${where} ORDER BY c.sort_order, sub.name`,
    params
  );
  res.json(rows);
}));

// { staff_id, subject_id, class_id, section_id?, academic_year_id? } - academic_year_id
// defaults to the school's current year if not given.
router.post('/teaching-assignments', authorize('timetable.manage', 'academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { staff_id, subject_id, class_id, section_id } = req.body;
  if (!staff_id || !subject_id || !class_id) return res.status(400).json({ error: 'staff_id, subject_id, and class_id are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const academicYear = await getOrCreateCurrentAcademicYear(client, schoolId);
    const { rows } = await client.query(
      `INSERT INTO teacher_subject_class (school_id, staff_id, subject_id, class_id, section_id, academic_year_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [schoolId, staff_id, subject_id, class_id, section_id || null, academicYear.id]
    );
    await logAudit(client, { schoolId, tableName: 'teacher_subject_class', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/teaching-assignments/:id', authorize('timetable.manage', 'academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM teacher_subject_class WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }
    await client.query('DELETE FROM teacher_subject_class WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
    await logAudit(client, { schoolId, tableName: 'teacher_subject_class', recordId: req.params.id, action: 'delete', changedBy: req.user.id, oldValues: existing[0], newValues: null });
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Timetable ----
router.get('/timetable', authorize('timetable.manage', 'academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 't.school_id = $1';
  if (req.query.class_id) { params.push(req.query.class_id); where += ` AND t.class_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT t.*, sub.name AS subject_name, st.first_name, st.last_name, c.name AS class_name
     FROM timetable_entries t
     JOIN subjects sub ON sub.id = t.subject_id
     JOIN staff st ON st.id = t.staff_id
     JOIN classes c ON c.id = t.class_id
     WHERE ${where} ORDER BY t.day_of_week, t.period_number`,
    params
  );
  res.json(rows);
}));

// { class_id, section_id?, subject_id, staff_id, day_of_week (0-6), period_number, start_time, end_time }
router.post('/timetable', authorize('timetable.manage', 'academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { class_id, section_id, subject_id, staff_id, day_of_week, period_number, start_time, end_time } = req.body;
  if (class_id == null || subject_id == null || staff_id == null || day_of_week == null || period_number == null || !start_time || !end_time) {
    return res.status(400).json({ error: 'class_id, subject_id, staff_id, day_of_week, period_number, start_time, and end_time are all required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO timetable_entries (school_id, class_id, section_id, subject_id, staff_id, day_of_week, period_number, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [schoolId, class_id, section_id || null, subject_id, staff_id, day_of_week, period_number, start_time, end_time]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ error: 'end_time must be after start_time' });
    throw err;
  }
}));

router.delete('/timetable/:id', authorize('timetable.manage', 'academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM timetable_entries WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Timetable entry not found' });
    }
    await client.query('DELETE FROM timetable_entries WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
    await logAudit(client, { schoolId, tableName: 'timetable_entries', recordId: req.params.id, action: 'delete', changedBy: req.user.id, oldValues: existing[0], newValues: null });
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
