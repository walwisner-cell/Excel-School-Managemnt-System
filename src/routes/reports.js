const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(authorize('reports.view'));

// GET /reports/dashboard - everything both the Dashboard tab and the Reports tab need,
// in one call: { active_students, active_staff, open_admission_inquiries,
// outstanding_invoices, outstanding_balance, today_attendance_breakdown: [{label, count}] }
router.get('/dashboard', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const today = new Date().toISOString().slice(0, 10);

  const [students, staff, inquiries, invoices, attendance] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM students WHERE school_id = $1 AND status = 'active'`, [schoolId]),
    pool.query(`SELECT COUNT(*) FROM staff WHERE school_id = $1 AND status = 'active'`, [schoolId]),
    pool.query(`SELECT COUNT(*) FROM admission_inquiries WHERE school_id = $1 AND status NOT IN ('enrolled', 'rejected')`, [schoolId]),
    pool.query(`SELECT COUNT(*), COALESCE(SUM(total_amount - amount_paid), 0) AS outstanding FROM invoices WHERE school_id = $1 AND status IN ('unpaid', 'partial', 'overdue')`, [schoolId]),
    pool.query(
      `SELECT ast.label, COUNT(*) AS count
       FROM student_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
       WHERE sa.school_id = $1 AND sa.attendance_date = $2 AND sa.period_number IS NULL
       GROUP BY ast.label ORDER BY ast.label`,
      [schoolId, today]
    ),
  ]);

  res.json({
    active_students: Number(students.rows[0].count),
    active_staff: Number(staff.rows[0].count),
    open_admission_inquiries: Number(inquiries.rows[0].count),
    outstanding_invoices: Number(invoices.rows[0].count),
    outstanding_balance: Number(invoices.rows[0].outstanding),
    today_attendance_breakdown: attendance.rows.map((r) => ({ label: r.label, count: Number(r.count) })),
  });
}));

module.exports = router;
