const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

router.get('/categories', authorize('expenses.view', 'expenses.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query('SELECT * FROM expense_categories WHERE school_id = $1 ORDER BY name', [schoolId]);
  res.json(rows);
}));

router.post('/categories', authorize('expenses.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO expense_categories (school_id, name) VALUES ($1, $2) RETURNING *',
      [schoolId, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with this name already exists' });
    throw err;
  }
}));

router.get('/', authorize('expenses.view', 'expenses.manage', 'expenses.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT e.*, ec.name AS category_name FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
     WHERE e.school_id = $1 ORDER BY e.expense_date DESC, e.id DESC`,
    [schoolId]
  );
  res.json(rows);
}));

// { category_id?, description, amount, expense_date?, receipt_reference? }
// Always starts pending_approval - see POST /:id/approve and /:id/reject.
router.post('/', authorize('expenses.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { category_id, description, amount, expense_date, receipt_reference } = req.body;
  if (!description || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'description and a positive amount are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO expenses (school_id, category_id, description, amount, expense_date, receipt_reference, recorded_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7) RETURNING *`,
      [schoolId, category_id || null, description, amount, expense_date || null, receipt_reference || null, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'expenses', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(
      `SELECT e.*, ec.name AS category_name FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id WHERE e.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/:id/approve', authorize('expenses.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE expenses SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
     WHERE id = $2 AND school_id = $3 AND status = 'pending_approval' RETURNING *`,
    [req.user.id, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Expense not found, or not pending approval' });
  res.json(rows[0]);
}));

router.post('/:id/reject', authorize('expenses.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { reason } = req.body;
  const { rows } = await pool.query(
    `UPDATE expenses SET status = 'rejected', approved_by = $1, approved_at = now(), rejection_reason = $2, updated_at = now()
     WHERE id = $3 AND school_id = $4 AND status = 'pending_approval' RETURNING *`,
    [req.user.id, reason || null, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Expense not found, or not pending approval' });
  res.json(rows[0]);
}));

module.exports = router;
