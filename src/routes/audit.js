const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(authorize('audit.view'));

// ?table=&from=&to=&limit= (all optional) - every logAudit() call throughout the
// system writes here; this is simply the first screen that lets anyone actually
// see it, rather than the data just accumulating unseen.
router.get('/', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'al.school_id = $1';
  if (req.query.table) { params.push(req.query.table); where += ` AND al.table_name = $${params.length}`; }
  if (req.query.from) { params.push(req.query.from); where += ` AND al.changed_at >= $${params.length}`; }
  if (req.query.to) { params.push(req.query.to + ' 23:59:59'); where += ` AND al.changed_at <= $${params.length}`; }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { rows } = await pool.query(
    `SELECT al.id, al.table_name, al.record_id, al.action, al.changed_at, al.old_values, al.new_values, u.email AS changed_by_email
     FROM audit_logs al LEFT JOIN users u ON u.id = al.changed_by
     WHERE ${where} ORDER BY al.changed_at DESC LIMIT ${limit}`,
    params
  );
  res.json(rows);
}));

// Distinct table names actually present in the log, for building the filter dropdown.
router.get('/tables', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT DISTINCT table_name FROM audit_logs WHERE school_id = $1 ORDER BY table_name', [schoolId]);
  res.json(rows.map((r) => r.table_name));
}));

module.exports = router;
