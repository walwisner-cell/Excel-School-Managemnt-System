const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const UPLOADS_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
function galleryDir(schoolId) {
  return path.join(UPLOADS_ROOT, String(schoolId), 'gallery');
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const schoolId = resolveSchoolId(req);
    const dir = galleryDir(schoolId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const randomName = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).slice(0, 10);
    cb(null, randomName);
  },
});
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per photo
  fileFilter(req, file, cb) {
    if (!ALLOWED_IMAGE_MIME.has(file.mimetype)) return cb(new Error(`Only JPEG, PNG, or WEBP images are allowed (got ${file.mimetype})`));
    cb(null, true);
  },
});

router.use(authenticate);

router.get('/', authorize('gallery.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT * FROM gallery_photos WHERE school_id = $1 ORDER BY sort_order, uploaded_at DESC', [schoolId]);
  res.json(rows);
}));

// multipart/form-data: file (the image), caption?, is_public? ('true'/'false' as a string)
router.post('/', authorize('gallery.manage'), upload.single('file'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!req.file) return res.status(400).json({ error: 'A photo file is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO gallery_photos (school_id, caption, original_name, stored_name, mime_type, size_bytes, is_public, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [schoolId, req.body.caption || null, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size,
       req.body.is_public !== 'false', req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'gallery_photos', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    fs.promises.unlink(req.file.path).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/:id', authorize('gallery.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const fields = ['caption', 'is_public', 'sort_order'];
  const setCols = fields.filter((f) => f in req.body);
  if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });
  const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const values = setCols.map((f) => req.body[f]);
  values.push(req.params.id, schoolId);
  const { rows } = await pool.query(
    `UPDATE gallery_photos SET ${setClause} WHERE id = $${values.length - 1} AND school_id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'Photo not found' });
  res.json(rows[0]);
}));

// { placement: 'home_hero' | 'about_hero' | 'academics_hero' | 'admissions_hero' | null }
// Only one photo per placement is allowed (enforced by a unique index) - setting
// a new one for a placement first clears whichever photo held it before.
const VALID_PLACEMENTS = ['home_hero', 'about_hero', 'academics_hero', 'admissions_hero'];
router.put('/:id/placement', authorize('gallery.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { placement } = req.body;
  if (placement !== null && !VALID_PLACEMENTS.includes(placement)) {
    return res.status(400).json({ error: `placement must be one of ${VALID_PLACEMENTS.join(', ')}, or null to clear` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: photoRows } = await client.query('SELECT id FROM gallery_photos WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!photoRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Photo not found' });
    }
    if (placement !== null) {
      await client.query('UPDATE gallery_photos SET placement = NULL WHERE school_id = $1 AND placement = $2', [schoolId, placement]);
    }
    // A hero image only makes sense if it's actually public - enforced here, not
    // just as a frontend convenience, so no caller (UI bug, direct API call, etc.)
    // can end up with a "featured" photo that's actually private.
    const { rows } = await client.query(
      `UPDATE gallery_photos SET placement = $1, is_public = CASE WHEN $1::varchar IS NOT NULL THEN true ELSE is_public END WHERE id = $2 RETURNING *`,
      [placement, req.params.id]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.delete('/:id', authorize('gallery.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('DELETE FROM gallery_photos WHERE id = $1 AND school_id = $2 RETURNING *', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Photo not found' });
  fs.promises.unlink(path.join(galleryDir(schoolId), rows[0].stored_name)).catch(() => {});
  await logAudit(pool, { schoolId, tableName: 'gallery_photos', recordId: rows[0].id, action: 'delete', changedBy: req.user.id, oldValues: rows[0], newValues: null }).catch(() => {});
  res.status(204).send();
}));

// Authenticated preview for the admin Gallery screen - shows regardless of
// is_public status (staff should be able to preview a photo before deciding
// whether to publish it). The public, unauthenticated version of this lives in
// src/routes/public.js and only ever serves photos already marked public.
router.get('/:id/file', authorize('gallery.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT * FROM gallery_photos WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  const photo = rows[0];
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  res.sendFile(path.join(galleryDir(schoolId), photo.stored_name), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Photo file not found' });
  });
}));

module.exports = router;
