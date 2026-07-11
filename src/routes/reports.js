const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { convert } = require('../utils/currency');

const router = express.Router();
router.use(authenticate);
router.use(authorize('reports.view'));

// GET /reports/dashboard - everything both the Dashboard tab and the Reports tab need,
// in one call: { active_students, active_staff, open_admission_inquiries,
// outstanding_invoices, outstanding_balance, outstanding_balance_currency,
// today_attendance_breakdown: [{label, count}] }
//
// outstanding_balance is converted into the school's primary_currency using its
// CURRENT exchange rate (not each invoice's own snapshotted rate) - this is a live
// "as of right now" figure for the dashboard, not a historical record, so summing
// USD and LRD invoices together without converting first would otherwise produce a
// meaningless mixed number.
router.get('/dashboard', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const today = new Date().toISOString().slice(0, 10);

  const [school, students, staff, inquiries, openInvoices, attendance] = await Promise.all([
    pool.query('SELECT primary_currency, exchange_rate_lrd_per_usd FROM schools WHERE id = $1', [schoolId]),
    pool.query(`SELECT COUNT(*) FROM students WHERE school_id = $1 AND status = 'active'`, [schoolId]),
    pool.query(`SELECT COUNT(*) FROM staff WHERE school_id = $1 AND status = 'active'`, [schoolId]),
    pool.query(`SELECT COUNT(*) FROM admission_inquiries WHERE school_id = $1 AND status NOT IN ('enrolled', 'rejected')`, [schoolId]),
    pool.query(
      `SELECT total_amount, amount_paid, currency FROM invoices WHERE school_id = $1 AND status IN ('unpaid', 'partial', 'overdue')`,
      [schoolId]
    ),
    pool.query(
      `SELECT ast.label, COUNT(*) AS count
       FROM student_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
       WHERE sa.school_id = $1 AND sa.attendance_date = $2 AND sa.period_number IS NULL
       GROUP BY ast.label ORDER BY ast.label`,
      [schoolId, today]
    ),
  ]);

  const primaryCurrency = school.rows[0]?.primary_currency || 'USD';
  const rate = school.rows[0]?.exchange_rate_lrd_per_usd || 1;
  const outstandingBalance = openInvoices.rows.reduce((sum, inv) => {
    const balance = Number(inv.total_amount) - Number(inv.amount_paid);
    return sum + convert(balance, inv.currency, rate, primaryCurrency, rate);
  }, 0);

  res.json({
    active_students: Number(students.rows[0].count),
    active_staff: Number(staff.rows[0].count),
    open_admission_inquiries: Number(inquiries.rows[0].count),
    outstanding_invoices: openInvoices.rows.length,
    outstanding_balance: Math.round(outstandingBalance * 100) / 100,
    outstanding_balance_currency: primaryCurrency,
    today_attendance_breakdown: attendance.rows.map((r) => ({ label: r.label, count: Number(r.count) })),
  });
}));

module.exports = router;
