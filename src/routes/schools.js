const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// ---- Self-service settings: any school-level admin can view/edit THEIR OWN
// school's basics and currency settings. Not gated by schools.manage (that's for
// super_admin creating/editing tenants generally) - gated by school_settings.manage
// instead, which school_admin/principal hold. super_admin can also use these via
// ?school_id=, same as everything else. ----
router.get('/current', authorize('school_settings.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT * FROM schools WHERE id = $1', [schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'School not found' });
  res.json(rows[0]);
}));

router.put('/current', authorize('school_settings.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const fields = ['name', 'address', 'phone', 'email', 'primary_currency', 'exchange_rate_lrd_per_usd'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  if ('primary_currency' in req.body && !['USD', 'LRD'].includes(req.body.primary_currency)) {
    return res.status(400).json({ error: "primary_currency must be 'USD' or 'LRD'" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM schools WHERE id = $1 FOR UPDATE', [schoolId]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'School not found' });
    }
    const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = setCols.map((f) => req.body[f]);
    values.push(schoolId);
    const { rows } = await client.query(
      `UPDATE schools SET ${setClause}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values
    );
    await logAudit(client, { schoolId, tableName: 'schools', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: rows[0] });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// School logo upload - self-service (school_settings.manage), same as the rest
// of this section. Stored on disk the same way gallery photos and documents are.
const logoStorage = multer.diskStorage({
  destination(req, file, cb) {
    const schoolId = resolveSchoolId(req);
    const dir = path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), String(schoolId), 'logo');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, 'logo' + path.extname(file.originalname).slice(0, 10));
  },
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'].includes(file.mimetype)) {
      return cb(new Error(`Only JPEG, PNG, WEBP, or SVG logos are allowed (got ${file.mimetype})`));
    }
    cb(null, true);
  },
});

router.post('/current/logo', authorize('school_settings.manage'), logoUpload.single('logo'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!req.file) return res.status(400).json({ error: 'A logo file is required' });
  const { rows } = await pool.query(
    `UPDATE schools SET logo_original_name = $1, logo_stored_name = $2, logo_mime_type = $3, updated_at = now()
     WHERE id = $4 RETURNING *`,
    [req.file.originalname, req.file.filename, req.file.mimetype, schoolId]
  );
  res.json(rows[0]);
}));

router.get('/current/logo', authorize('school_settings.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT logo_stored_name FROM schools WHERE id = $1', [schoolId]);
  if (!rows[0]?.logo_stored_name) return res.status(404).json({ error: 'No logo uploaded yet' });
  res.sendFile(path.join(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'), String(schoolId), 'logo', rows[0].logo_stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Logo file not found' });
  });
}));

// ---- Tenant management: super_admin only, from here down ----
router.use(authorize('schools.manage'));

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM schools ORDER BY name');
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM schools WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'School not found' });
  res.json(rows[0]);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, code, address, phone, email } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO schools (name, code, address, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, code, address || null, phone || null, email || null]
    );
    await logAudit(client, { schoolId: rows[0].id, tableName: 'schools', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const fields = ['name', 'code', 'address', 'phone', 'email', 'status'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM schools WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'School not found' });
    }
    const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = setCols.map((f) => req.body[f]);
    values.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE schools SET ${setClause}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values
    );
    await logAudit(client, { schoolId: rows[0].id, tableName: 'schools', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: existing[0], newValues: rows[0] });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
