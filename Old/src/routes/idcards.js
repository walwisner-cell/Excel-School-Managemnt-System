const express = require('express');
const PDFDocument = require('pdfkit');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { listDocuments, absolutePath } = require('../utils/documents');

const router = express.Router();
router.use(authenticate);
router.use(authorize('idcards.generate'));

const CARD_W = 242; // ~3.375in at 72dpi (standard CR80 card width)
const CARD_H = 153; // ~2.125in

// Looks for a document labeled like a photo (e.g. "Passport Photo") with an image
// mime type among the owner's uploaded documents - added once document uploads
// became real in this pass. Falls back to null (placeholder box) if none exists.
async function findPhotoPath(ownerType, ownerId, schoolId) {
  const docs = await listDocuments(ownerType, ownerId, schoolId);
  const photo = docs.find((d) => /photo/i.test(d.label || '') && d.mime_type && d.mime_type.startsWith('image/'));
  return photo ? absolutePath(photo) : null;
}

function drawCard(doc, { schoolName, name, subtitle, idLabel, idValue, photoPath }, x, y) {
  doc.save();
  doc.rect(x, y, CARD_W, CARD_H).lineWidth(1).stroke('#16324f');
  doc.rect(x, y, CARD_W, 34).fill('#16324f');
  doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text(schoolName, x + 10, y + 10, { width: CARD_W - 20 });
  doc.fillColor('#1a2130').fontSize(13).font('Helvetica-Bold').text(name, x + 10, y + 46, { width: CARD_W - 20 });
  doc.fontSize(9).font('Helvetica').fillColor('#545b6b').text(subtitle || '', x + 10, y + 64, { width: CARD_W - 20 });
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#8f6a12').text(`${idLabel}: ${idValue}`, x + 10, y + CARD_H - 24, { width: CARD_W - 20 });

  const boxX = x + CARD_W - 70, boxY = y + 44, boxSize = 56;
  if (photoPath) {
    try {
      doc.image(photoPath, boxX, boxY, { fit: [boxSize, boxSize], align: 'center', valign: 'center' });
      doc.rect(boxX, boxY, boxSize, boxSize).lineWidth(0.75).stroke('#c9a227');
    } catch {
      // Corrupt/unreadable image file - fall back to the placeholder box below rather than fail the whole PDF.
      doc.rect(boxX, boxY, boxSize, boxSize).lineWidth(0.75).dash(2, { space: 2 }).stroke('#c9a227').undash();
      doc.fontSize(7).fillColor('#8f6a12').text('NO PHOTO', boxX, boxY + 24, { width: boxSize, align: 'center' });
    }
  } else {
    doc.rect(boxX, boxY, boxSize, boxSize).lineWidth(0.75).dash(2, { space: 2 }).stroke('#c9a227').undash();
    doc.fontSize(7).fillColor('#8f6a12').text('NO PHOTO', boxX, boxY + 24, { width: boxSize, align: 'center' });
  }
  doc.restore();
}

async function getSchoolName(schoolId) {
  const { rows } = await pool.query('SELECT name FROM schools WHERE id = $1', [schoolId]);
  return rows[0] ? rows[0].name : 'School';
}

router.get('/students/:id.pdf', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.id = $1 AND s.school_id = $2`,
    [req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Student not found' });
  const [schoolName, photoPath] = await Promise.all([getSchoolName(schoolId), findPhotoPath('student', rows[0].id, schoolId)]);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="student-${rows[0].admission_no}.pdf"`);
  const doc = new PDFDocument({ size: [CARD_W + 40, CARD_H + 40], margin: 0 });
  doc.pipe(res);
  drawCard(doc, {
    schoolName, name: `${rows[0].first_name} ${rows[0].last_name}`,
    subtitle: rows[0].class_name || 'Unassigned class', idLabel: 'Admission No', idValue: rows[0].admission_no, photoPath,
  }, 20, 20);
  doc.end();
}));

router.get('/staff/:id.pdf', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Staff member not found' });
  const schoolName = await getSchoolName(schoolId);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="staff-${rows[0].employee_no}.pdf"`);
  const doc = new PDFDocument({ size: [CARD_W + 40, CARD_H + 40], margin: 0 });
  doc.pipe(res);
  drawCard(doc, {
    schoolName, name: `${rows[0].first_name} ${rows[0].last_name}`,
    subtitle: rows[0].designation || 'Staff', idLabel: 'Employee No', idValue: rows[0].employee_no, photoPath: null,
  }, 20, 20);
  doc.end();
}));

// Batch: every active student, optionally filtered to one class, 2 cards per page.
router.get('/students/batch.pdf', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = "s.school_id = $1 AND s.status = 'active'";
  if (req.query.class_id) { params.push(req.query.class_id); where += ` AND s.class_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE ${where} ORDER BY s.last_name, s.first_name`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'No matching students found' });
  const schoolName = await getSchoolName(schoolId);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="id-cards-batch.pdf"');
  const doc = new PDFDocument({ size: 'A4', margin: 20 });
  doc.pipe(res);

  const perRow = 2;
  const marginX = 20, marginY = 20, gapX = 20, gapY = 16;
  let col = 0, row = 0;
  const rowsPerPage = 4;

  for (let i = 0; i < rows.length; i++) {
    const student = rows[i];
    if (i > 0 && col === 0 && row === 0) doc.addPage();
    const x = marginX + col * (CARD_W + gapX);
    const y = marginY + row * (CARD_H + gapY);
    const photoPath = await findPhotoPath('student', student.id, schoolId);
    drawCard(doc, {
      schoolName, name: `${student.first_name} ${student.last_name}`,
      subtitle: student.class_name || 'Unassigned class', idLabel: 'Admission No', idValue: student.admission_no, photoPath,
    }, x, y);
    col += 1;
    if (col >= perRow) { col = 0; row += 1; }
    if (row >= rowsPerPage) { row = 0; }
  }
  doc.end();
}));

module.exports = router;
