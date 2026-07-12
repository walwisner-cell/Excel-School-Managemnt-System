const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pool = require('../../config/db');
const { logAudit } = require('./audit');

const UPLOADS_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');

function ownerDir(schoolId, ownerType, ownerId) {
  return path.join(UPLOADS_ROOT, String(schoolId), ownerType, String(ownerId));
}

// multer storage: destination depends on schoolId/ownerType/ownerId already resolved
// onto req by the route handler (see admissions.js / students.js), so the folder
// structure mirrors documents.owner_type/owner_id and never trusts client-supplied paths.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = ownerDir(req.uploadContext.schoolId, req.uploadContext.ownerType, req.uploadContext.ownerId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const randomName = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).slice(0, 10);
    cb(null, randomName);
  },
});

const ALLOWED_MIME = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    cb(null, true);
  },
});

async function recordDocument(client, { schoolId, ownerType, ownerId, label, file, uploadedBy }) {
  const { rows } = await client.query(
    `INSERT INTO documents (school_id, owner_type, owner_id, label, original_name, stored_name, mime_type, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [schoolId, ownerType, ownerId, label || null, file.originalname, file.filename, file.mimetype, file.size, uploadedBy]
  );
  return rows[0];
}

async function listDocuments(ownerType, ownerId, schoolId) {
  const { rows } = await pool.query(
    'SELECT * FROM documents WHERE owner_type = $1 AND owner_id = $2 AND school_id = $3 ORDER BY uploaded_at DESC',
    [ownerType, ownerId, schoolId]
  );
  return rows;
}

async function getDocumentOr404(id, schoolId) {
  const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1 AND school_id = $2', [id, schoolId]);
  return rows[0] || null;
}

function absolutePath(doc) {
  return path.join(ownerDir(doc.school_id, doc.owner_type, doc.owner_id), doc.stored_name);
}

async function deleteDocument(doc, changedBy) {
  await pool.query('DELETE FROM documents WHERE id = $1', [doc.id]);
  fs.promises.unlink(absolutePath(doc)).catch(() => {}); // best-effort; DB row is the source of truth
  // Best-effort, non-transactional (this utility doesn't have a client from the
  // caller's transaction) - a document delete is a single DB statement anyway,
  // so this still reliably lands even without wrapping both in one transaction.
  await logAudit(pool, { schoolId: doc.school_id, tableName: 'documents', recordId: doc.id, action: 'delete', changedBy, oldValues: doc, newValues: null }).catch(() => {});
}

module.exports = { upload, recordDocument, listDocuments, getDocumentOr404, absolutePath, deleteDocument };
