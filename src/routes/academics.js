const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

router.use('/academic-years', buildCrudRouter({
  table: 'academic_years',
  fields: ['name', 'start_date', 'end_date', 'is_current'],
  requiredOnCreate: ['name', 'start_date', 'end_date'],
  viewPermission: 'academics.manage',
  managePermission: 'academics.manage',
  orderBy: 'start_date DESC',
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

router.use(authenticate);

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
  const { rows } = await pool.query('DELETE FROM classes WHERE id = $1 AND school_id = $2 RETURNING id', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Class not found' });
  res.status(204).send();
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
  const { rows } = await pool.query('DELETE FROM terms WHERE id = $1 AND school_id = $2 RETURNING id', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Term not found' });
  res.status(204).send();
}));

module.exports = router;
