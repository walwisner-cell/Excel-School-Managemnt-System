const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextNumber } = require('../utils/numberSequence');

const { convert } = require('../utils/currency');

const router = express.Router();
router.use(authenticate);

router.use('/structures', buildCrudRouter({
  table: 'fee_structures',
  fields: ['academic_year_id', 'term_id', 'class_id', 'fee_type', 'amount', 'currency', 'frequency', 'due_date'],
  requiredOnCreate: ['academic_year_id', 'fee_type', 'amount'],
  viewPermission: 'fees.view',
  managePermission: 'fees.manage',
  searchFields: ['fee_type'],
  orderBy: 'fee_type',
}));

const PAYMENT_SELECT = `
  SELECT p.*,
         ru.email AS recorded_by_email,
         cu.email AS reconciled_by_email,
         au.email AS approved_by_email
  FROM payments p
  LEFT JOIN users ru ON ru.id = p.recorded_by
  LEFT JOIN users cu ON cu.id = p.reconciled_by
  LEFT JOIN users au ON au.id = p.approved_by`;

async function recomputeInvoiceTotals(client, invoiceId) {
  const { rows: totals } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS total, COALESCE(SUM(amount_paid), 0) AS paid FROM invoice_items WHERE invoice_id = $1`,
    [invoiceId]
  );
  const { total, paid } = totals[0];
  const status = Number(paid) >= Number(total) && Number(total) > 0 ? 'paid' : Number(paid) > 0 ? 'partial' : 'unpaid';
  await client.query('UPDATE invoices SET amount_paid = $1, status = $2, updated_at = now() WHERE id = $3', [paid, status, invoiceId]);
}

async function getSchoolCurrencyDefaults(client, schoolId) {
  const { rows } = await client.query('SELECT primary_currency, exchange_rate_lrd_per_usd FROM schools WHERE id = $1', [schoolId]);
  return rows[0] || { primary_currency: 'USD', exchange_rate_lrd_per_usd: 1 };
}

// ---- Invoices ----

router.get('/invoices', authorize('fees.view', 'fees.collect', 'fees.manage', 'fees.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'i.school_id = $1';
  if (req.query.student_id) { params.push(req.query.student_id); where += ` AND i.student_id = $${params.length}`; }
  if (req.query.status) { params.push(req.query.status); where += ` AND i.status = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT i.*, s.first_name, s.last_name FROM invoices i JOIN students s ON s.id = i.student_id
     WHERE ${where} ORDER BY i.created_at DESC`,
    params
  );
  res.json(rows);
}));

router.get('/invoices/:id', authorize('fees.view', 'fees.collect', 'fees.manage', 'fees.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT i.*, s.first_name, s.last_name FROM invoices i JOIN students s ON s.id = i.student_id
     WHERE i.id = $1 AND i.school_id = $2`,
    [req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' });
  const { rows: items } = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [req.params.id]);
  res.json({ ...rows[0], items });
}));

// { student_id, academic_year_id, term_id?, invoice_no?, due_date?, currency?, items: [{ description?, amount }] }
// currency defaults to the school's primary_currency; exchange_rate_lrd_per_usd is
// snapshotted from the school's current rate at creation time so this invoice's
// LRD/USD equivalent stays fixed even if the school's rate changes later.
router.post('/invoices', authorize('fees.manage', 'fees.collect'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { student_id, academic_year_id, term_id, invoice_no, due_date, items } = req.body;
  if (!student_id || !academic_year_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'student_id, academic_year_id, and a non-empty items array are required' });
  }
  const totalAmount = items.reduce((sum, it) => sum + Number(it.amount), 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schoolDefaults = await getSchoolCurrencyDefaults(client, schoolId);
    const currency = ['USD', 'LRD'].includes(req.body.currency) ? req.body.currency : schoolDefaults.primary_currency;
    const finalInvoiceNo = invoice_no || await nextNumber(client, schoolId, 'invoice', { prefix: 'INV', digits: 6 });
    const { rows } = await client.query(
      `INSERT INTO invoices (school_id, student_id, academic_year_id, term_id, invoice_no, total_amount, currency, exchange_rate_lrd_per_usd, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [schoolId, student_id, academic_year_id, term_id || null, finalInvoiceNo, totalAmount, currency, schoolDefaults.exchange_rate_lrd_per_usd, due_date || null]
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, fee_structure_id, description, amount) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, item.fee_structure_id || null, item.description || null, item.amount]
      );
    }
    await logAudit(client, { schoolId, tableName: 'invoices', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: withStudent } = await pool.query(
      `SELECT i.*, s.first_name, s.last_name FROM invoices i JOIN students s ON s.id = i.student_id WHERE i.id = $1`,
      [rows[0].id]
    );
    res.status(201).json(withStudent[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'An invoice with this number already exists' });
    throw err;
  } finally {
    client.release();
  }
}));

// { class_id, academic_year_id, term_id?, currency?, due_date?, items } - creates
// one invoice per ACTIVE student in the given class, all with the same line
// items. A real time-saver over creating each student's term-fee invoice one at
// a time, which is what every school actually needs to do at the start of a term.
router.post('/invoices/bulk-by-class', authorize('fees.manage', 'fees.collect'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { class_id, academic_year_id, term_id, due_date, items } = req.body;
  if (!class_id || !academic_year_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'class_id, academic_year_id, and a non-empty items array are required' });
  }
  const totalAmount = items.reduce((sum, it) => sum + Number(it.amount), 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: students } = await client.query(
      `SELECT id FROM students WHERE school_id = $1 AND class_id = $2 AND status = 'active'`,
      [schoolId, class_id]
    );
    if (!students.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active students found in that class' });
    }
    const schoolDefaults = await getSchoolCurrencyDefaults(client, schoolId);
    const currency = ['USD', 'LRD'].includes(req.body.currency) ? req.body.currency : schoolDefaults.primary_currency;
    const created = [];
    for (const student of students) {
      const invoiceNo = await nextNumber(client, schoolId, 'invoice', { prefix: 'INV', digits: 6 });
      const { rows } = await client.query(
        `INSERT INTO invoices (school_id, student_id, academic_year_id, term_id, invoice_no, total_amount, currency, exchange_rate_lrd_per_usd, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [schoolId, student.id, academic_year_id, term_id || null, invoiceNo, totalAmount, currency, schoolDefaults.exchange_rate_lrd_per_usd, due_date || null]
      );
      for (const item of items) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, fee_structure_id, description, amount) VALUES ($1, $2, $3, $4)`,
          [rows[0].id, item.fee_structure_id || null, item.description || null, item.amount]
        );
      }
      created.push(rows[0].id);
    }
    await logAudit(client, { schoolId, tableName: 'invoices', recordId: null, action: 'create', changedBy: req.user.id, oldValues: null, newValues: { class_id, count: created.length } });
    await client.query('COMMIT');
    res.status(201).json({ created: created.length, invoiceIds: created });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Payments: Stage 1 record ----

router.get('/invoices/:id/payments', authorize('fees.view', 'fees.collect', 'fees.manage', 'fees.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: invoiceRows } = await pool.query('SELECT id FROM invoices WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
  if (!invoiceRows[0]) return res.status(404).json({ error: 'Invoice not found' });
  const { rows } = await pool.query(`${PAYMENT_SELECT} WHERE p.invoice_id = $1 ORDER BY p.created_at DESC`, [req.params.id]);
  res.json(rows);
}));

const NON_CASH_METHODS = ['bank_transfer', 'cheque', 'card', 'online'];

// { amount, currency?, payment_method, reference_number?, bank_name?, payment_date?, idempotency_key }
// idempotency_key is required from the UI (a client-generated UUID) so a double-click
// or network retry can never create two payments for the same submission. currency
// defaults to the school's primary currency but can differ from the invoice's own
// currency (e.g. invoice in USD, parent pays cash in LRD) - see approve() below for
// how that gets converted at allocation time.
router.post('/invoices/:id/payments', authorize('fees.collect'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { amount, payment_method, reference_number, bank_name, payment_date, idempotency_key } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A positive amount is required' });
  if (!payment_method) return res.status(400).json({ error: 'payment_method is required' });
  if (NON_CASH_METHODS.includes(payment_method) && !reference_number) {
    return res.status(400).json({ error: `reference_number is required for ${payment_method}` });
  }

  if (idempotency_key) {
    const { rows: existing } = await pool.query(`${PAYMENT_SELECT} WHERE p.idempotency_key = $1`, [idempotency_key]);
    if (existing[0]) return res.json({ ...existing[0], deduplicated: true });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: invoiceRows } = await client.query('SELECT * FROM invoices WHERE id = $1 AND school_id = $2', [req.params.id, schoolId]);
    if (!invoiceRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const schoolDefaults = await getSchoolCurrencyDefaults(client, schoolId);
    const currency = ['USD', 'LRD'].includes(req.body.currency) ? req.body.currency : schoolDefaults.primary_currency;
    const receiptNo = await nextNumber(client, schoolId, 'receipt', { prefix: 'RCPT', digits: 6 });
    const { rows } = await client.query(
      `INSERT INTO payments (school_id, student_id, invoice_id, receipt_no, amount_paid, currency, exchange_rate_lrd_per_usd, payment_method,
                              reference_number, bank_name, payment_date, idempotency_key, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, CURRENT_DATE), $12, $13) RETURNING *`,
      [schoolId, invoiceRows[0].student_id, req.params.id, receiptNo, amount, currency, schoolDefaults.exchange_rate_lrd_per_usd, payment_method,
       reference_number || null, bank_name || null, payment_date || null, idempotency_key || null, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'payments', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [rows[0].id]);
    res.status(201).json({ ...full[0], deduplicated: false });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Duplicate receipt or idempotency key' });
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Stage 2: reconcile ----
// Cash: body {} - reconciler just confirms the cash count.
// Non-cash: body { statement_reference } - if it doesn't match reference_number,
// the payment is flagged instead of advancing, and the recorder gets it back to fix.
router.post('/payments/:id/reconcile', authorize('fees.collect'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: payRows } = await client.query('SELECT * FROM payments WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!payRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment not found' }); }
    const payment = payRows[0];
    if (payment.status !== 'pending_reconciliation') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Payment is '${payment.status}', not awaiting reconciliation` });
    }
    if (payment.recorded_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You cannot reconcile a payment you recorded yourself' });
    }

    let newStatus = 'pending_approval';
    let flagReason = null;
    const statementReference = req.body.statement_reference || null;
    if (NON_CASH_METHODS.includes(payment.payment_method)) {
      if (!statementReference) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'statement_reference is required to reconcile a non-cash payment' });
      }
      if (statementReference.trim() !== (payment.reference_number || '').trim()) {
        newStatus = 'flagged';
        flagReason = 'Statement reference does not match the recorded reference number.';
      }
    }

    const { rows } = await client.query(
      `UPDATE payments SET status = $1, reconciled_by = $2, reconciled_at = now(),
              statement_reference = $3, flag_reason = $4, updated_at = now()
       WHERE id = $5 RETURNING *`,
      [newStatus, req.user.id, statementReference, flagReason, req.params.id]
    );
    await logAudit(client, { schoolId, tableName: 'payments', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: payment, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [rows[0].id]);
    res.json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Stage 3: approve (Principal / super_admin only) ----
// On approval, the payment amount is allocated FIFO across the invoice's oldest
// unpaid items, and only THEN does it count toward invoice.amount_paid.
router.post('/payments/:id/approve', authorize('fees.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: payRows } = await client.query('SELECT * FROM payments WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!payRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment not found' }); }
    const payment = payRows[0];
    if (payment.status !== 'pending_approval') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Payment is '${payment.status}', not awaiting approval` });
    }
    if (payment.recorded_by === req.user.id || payment.reconciled_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You cannot approve a payment you recorded or reconciled yourself' });
    }

    const { rows: updated } = await client.query(
      `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );

    const { rows: invoiceRows } = await client.query('SELECT * FROM invoices WHERE id = $1', [payment.invoice_id]);
    const invoice = invoiceRows[0];

    // FIFO allocation across this invoice's open items, converting the payment's
    // currency into the invoice's currency first (e.g. invoice billed in USD, but
    // this particular payment came in as LRD cash) using each side's own snapshotted
    // exchange rate, so a rate change after the fact never retroactively changes
    // what was actually allocated.
    const { rows: openItems } = await client.query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 AND amount_paid < amount ORDER BY id FOR UPDATE`,
      [payment.invoice_id]
    );
    let remaining = convert(payment.amount_paid, payment.currency, payment.exchange_rate_lrd_per_usd, invoice.currency, invoice.exchange_rate_lrd_per_usd);
    for (const item of openItems) {
      if (remaining <= 0) break;
      const owed = Number(item.amount) - Number(item.amount_paid);
      const allocation = Math.min(owed, remaining);
      if (allocation <= 0) continue;
      await client.query('UPDATE invoice_items SET amount_paid = amount_paid + $1 WHERE id = $2', [allocation, item.id]);
      await client.query(
        `INSERT INTO payment_allocations (payment_id, invoice_item_id, amount_allocated) VALUES ($1, $2, $3)`,
        [payment.id, item.id, allocation]
      );
      remaining -= allocation;
    }
    await recomputeInvoiceTotals(client, payment.invoice_id);

    await logAudit(client, { schoolId, tableName: 'payments', recordId: updated[0].id, action: 'update', changedBy: req.user.id, oldValues: payment, newValues: updated[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [updated[0].id]);
    res.json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Fix & resubmit a flagged payment ----
router.post('/payments/:id/resubmit', authorize('fees.collect'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: payRows } = await client.query('SELECT * FROM payments WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!payRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment not found' }); }
    if (payRows[0].status !== 'flagged') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Payment is '${payRows[0].status}', not flagged` });
    }
    const referenceNumber = req.body.reference_number || payRows[0].reference_number;
    const { rows } = await client.query(
      `UPDATE payments SET status = 'pending_reconciliation', reference_number = $1,
              reconciled_by = NULL, reconciled_at = NULL, statement_reference = NULL, flag_reason = NULL,
              updated_at = now()
       WHERE id = $2 RETURNING *`,
      [referenceNumber, req.params.id]
    );
    await logAudit(client, { schoolId, tableName: 'payments', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: payRows[0], newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [rows[0].id]);
    res.json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---- Void (terminal, any state, requires a reason; reverses allocations if already approved) ----
router.post('/payments/:id/void', authorize('fees.manage', 'fees.approve'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required to void a payment' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: payRows } = await client.query('SELECT * FROM payments WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!payRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment not found' }); }
    const payment = payRows[0];
    if (payment.status === 'voided') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Payment is already voided' });
    }

    if (payment.status === 'approved') {
      const { rows: allocations } = await client.query('SELECT * FROM payment_allocations WHERE payment_id = $1', [payment.id]);
      for (const alloc of allocations) {
        await client.query('UPDATE invoice_items SET amount_paid = amount_paid - $1 WHERE id = $2', [alloc.amount_allocated, alloc.invoice_item_id]);
      }
      await client.query('DELETE FROM payment_allocations WHERE payment_id = $1', [payment.id]);
      await recomputeInvoiceTotals(client, payment.invoice_id);
    }

    const { rows } = await client.query(
      `UPDATE payments SET status = 'voided', voided_by = $1, voided_at = now(), voided_reason = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [req.user.id, reason, req.params.id]
    );
    await logAudit(client, { schoolId, tableName: 'payments', recordId: rows[0].id, action: 'update', changedBy: req.user.id, oldValues: payment, newValues: rows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [rows[0].id]);
    res.json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
