const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

router.get('/items/low-stock', authorize('inventory.view', 'inventory.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT * FROM inventory_items WHERE school_id = $1 AND status = 'active' AND quantity <= reorder_level ORDER BY name`,
    [schoolId]
  );
  res.json(rows);
}));

router.get('/items/:id/transactions', authorize('inventory.view', 'inventory.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT * FROM inventory_transactions WHERE item_id = $1 AND school_id = $2 ORDER BY created_at DESC LIMIT 200`,
    [req.params.id, schoolId]
  );
  res.json(rows);
}));

// { change: signed integer (e.g. 1 or -1), reason }
router.post('/items/:id/transactions', authorize('inventory.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { change, reason } = req.body;
  const delta = Number(change);
  if (!delta) return res.status(400).json({ error: 'change (a non-zero signed integer) is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: itemRows } = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!itemRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Inventory item not found' }); }

    const newQty = itemRows[0].quantity + delta;
    if (newQty < 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This change would take quantity below zero' });
    }

    await client.query('UPDATE inventory_items SET quantity = $1, updated_at = now(), updated_by = $2 WHERE id = $3', [newQty, req.user.id, req.params.id]);
    const { rows: txnRows } = await client.query(
      `INSERT INTO inventory_transactions (school_id, item_id, change, reason, performed_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [schoolId, req.params.id, delta, reason || null, req.user.id]
    );
    await logAudit(client, {
      schoolId, tableName: 'inventory_items', recordId: req.params.id, action: 'update', changedBy: req.user.id,
      oldValues: { quantity: itemRows[0].quantity }, newValues: { quantity: newQty, via_transaction: txnRows[0].id },
    });
    await client.query('COMMIT');
    res.status(201).json({ transaction: txnRows[0], quantity: newQty });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Mounted after the two specific /items/... routes above - if this came first,
// its own generic GET '/:id' would swallow "/items/low-stock" (treating
// "low-stock" as an id) before the real low-stock handler ever got a chance.
router.use('/items', buildCrudRouter({
  table: 'inventory_items',
  fields: ['name', 'category', 'sku', 'unit', 'quantity', 'reorder_level', 'unit_cost', 'location', 'status'],
  requiredOnCreate: ['name'],
  viewPermission: 'inventory.view',
  managePermission: 'inventory.manage',
  searchFields: ['name', 'category', 'sku'],
  orderBy: 'name',
}));

module.exports = router;
