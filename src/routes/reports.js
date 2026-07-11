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

/* ================= REPORT CENTER =================
   One endpoint per report, organized by module. Each accepts whatever filters
   actually make sense for it (date range, class, exam, etc.) rather than forcing
   every report through one generic shape - a fee collections report and a library
   circulation report genuinely need different parameters. */

// ---- Students ----
router.get('/students/by-class', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT COALESCE(c.name, 'Unassigned') AS class_name, COUNT(s.id) AS count
     FROM students s LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 AND s.status = 'active'
     GROUP BY c.name, c.sort_order ORDER BY c.sort_order NULLS LAST`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.class_name, count: Number(r.count) })));
}));

router.get('/students/by-status', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS count FROM students WHERE school_id = $1 GROUP BY status ORDER BY status`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.status, count: Number(r.count) })));
}));

router.get('/students/demographics', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const [gender, nationality] = await Promise.all([
    pool.query(`SELECT COALESCE(gender,'Not recorded') AS label, COUNT(*) AS count FROM students WHERE school_id = $1 AND status = 'active' GROUP BY gender`, [schoolId]),
    pool.query(`SELECT COALESCE(nationality,'Not recorded') AS label, COUNT(*) AS count FROM students WHERE school_id = $1 AND status = 'active' GROUP BY nationality ORDER BY COUNT(*) DESC`, [schoolId]),
  ]);
  res.json({
    byGender: gender.rows.map(r => ({ label: r.label, count: Number(r.count) })),
    byNationality: nationality.rows.map(r => ({ label: r.label, count: Number(r.count) })),
  });
}));

// ---- Admissions ----
router.get('/admissions/by-status', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS count FROM admission_inquiries WHERE school_id = $1 GROUP BY status ORDER BY status`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.status.replace(/_/g,' '), count: Number(r.count) })));
}));

router.get('/admissions/by-source', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT COALESCE(referral_source, 'Not recorded') AS label, COUNT(*) AS count FROM admission_inquiries WHERE school_id = $1 GROUP BY referral_source ORDER BY COUNT(*) DESC`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.label.replace(/_/g,' '), count: Number(r.count) })));
}));

// ---- Staff ----
router.get('/staff/by-designation', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT COALESCE(designation, 'Not recorded') AS label, COUNT(*) AS count FROM staff WHERE school_id = $1 AND status = 'active' GROUP BY designation ORDER BY COUNT(*) DESC`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.label, count: Number(r.count) })));
}));

router.get('/staff/by-department', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT COALESCE(department, 'Not recorded') AS label, COUNT(*) AS count FROM staff WHERE school_id = $1 AND status = 'active' GROUP BY department ORDER BY COUNT(*) DESC`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.label, count: Number(r.count) })));
}));

// ---- Attendance ----
// ?from=&to=&class_id= (all optional - defaults to the last 30 days, whole school)
router.get('/attendance/students', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const params = [schoolId, from, to];
  let where = 'sa.school_id = $1 AND sa.attendance_date BETWEEN $2 AND $3 AND sa.period_number IS NULL';
  if (req.query.class_id) { params.push(req.query.class_id); where += ` AND s.class_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT ast.label, COUNT(*) AS count
     FROM student_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id JOIN students s ON s.id = sa.student_id
     WHERE ${where} GROUP BY ast.label ORDER BY ast.label`,
    params
  );
  res.json({ from, to, breakdown: rows.map(r => ({ label: r.label, count: Number(r.count) })) });
}));

router.get('/attendance/staff', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT ast.label, COUNT(*) AS count
     FROM staff_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
     WHERE sa.school_id = $1 AND sa.attendance_date BETWEEN $2 AND $3
     GROUP BY ast.label ORDER BY ast.label`,
    [schoolId, from, to]
  );
  res.json({ from, to, breakdown: rows.map(r => ({ label: r.label, count: Number(r.count) })) });
}));

// ---- Academics ----
// ?exam_id= required - per-subject average marks and pass rate for one exam
router.get('/academics/exam-performance', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!req.query.exam_id) return res.status(400).json({ error: 'exam_id is required' });
  const { rows } = await pool.query(
    `SELECT sub.name AS subject_name, es.max_marks, es.passing_marks,
            COUNT(m.id) AS entries,
            ROUND(AVG(m.marks_obtained) FILTER (WHERE NOT m.is_absent), 1) AS average_marks,
            COUNT(*) FILTER (WHERE m.marks_obtained >= es.passing_marks AND NOT m.is_absent) AS passed,
            COUNT(*) FILTER (WHERE m.is_absent) AS absent
     FROM exam_subjects es
     JOIN subjects sub ON sub.id = es.subject_id
     JOIN exams e ON e.id = es.exam_id
     LEFT JOIN marks m ON m.exam_subject_id = es.id
     WHERE es.exam_id = $1 AND e.school_id = $2
     GROUP BY sub.name, es.max_marks, es.passing_marks`,
    [req.query.exam_id, schoolId]
  );
  res.json(rows.map(r => ({
    subject: r.subject_name, maxMarks: Number(r.max_marks), passingMarks: Number(r.passing_marks),
    entries: Number(r.entries), averageMarks: r.average_marks ? Number(r.average_marks) : null,
    passed: Number(r.passed), absent: Number(r.absent),
  })));
}));

// ---- Fees ----
// ?from=&to= (defaults to current month) - approved payments only, grouped by currency
router.get('/fees/collections', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT currency, payment_method, COUNT(*) AS count, SUM(amount_paid) AS total
     FROM payments WHERE school_id = $1 AND status = 'approved' AND payment_date BETWEEN $2 AND $3
     GROUP BY currency, payment_method ORDER BY currency, payment_method`,
    [schoolId, from, to]
  );
  res.json({ from, to, rows: rows.map(r => ({ currency: r.currency, method: r.payment_method, count: Number(r.count), total: Number(r.total) })) });
}));

router.get('/fees/outstanding-by-class', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT COALESCE(c.name, 'Unassigned') AS class_name, i.currency, SUM(i.total_amount - i.amount_paid) AS outstanding
     FROM invoices i JOIN students s ON s.id = i.student_id LEFT JOIN classes c ON c.id = s.class_id
     WHERE i.school_id = $1 AND i.status IN ('unpaid','partial','overdue')
     GROUP BY c.name, c.sort_order, i.currency ORDER BY c.sort_order NULLS LAST`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: `${r.class_name} (${r.currency})`, count: Number(r.outstanding) })));
}));

router.get('/fees/expenses-by-category', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT COALESCE(ec.name, 'Uncategorized') AS label, e.currency, SUM(e.amount) AS total
     FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
     WHERE e.school_id = $1 AND e.status = 'approved' AND e.expense_date BETWEEN $2 AND $3
     GROUP BY ec.name, e.currency ORDER BY SUM(e.amount) DESC`,
    [schoolId, from, to]
  );
  res.json({ from, to, breakdown: rows.map(r => ({ label: `${r.label} (${r.currency})`, count: Number(r.total) })) });
}));

// ---- Library ----
router.get('/library/circulation', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS count FROM book_loans WHERE school_id = $1 GROUP BY status`,
    [schoolId]
  );
  const overdue = await pool.query(
    `SELECT COUNT(*) AS count FROM book_loans WHERE school_id = $1 AND status = 'on_loan' AND due_date < CURRENT_DATE`,
    [schoolId]
  );
  res.json({
    breakdown: rows.map(r => ({ label: r.status.replace(/_/g,' '), count: Number(r.count) })),
    overdueCount: Number(overdue.rows[0].count),
  });
}));

router.get('/library/most-borrowed', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT b.title, COUNT(bl.id) AS count FROM book_loans bl JOIN library_books b ON b.id = bl.book_id
     WHERE bl.school_id = $1 GROUP BY b.title ORDER BY COUNT(bl.id) DESC LIMIT 10`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.title, count: Number(r.count) })));
}));

// ---- Transport ----
router.get('/transport/route-utilization', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT r.name AS label, COUNT(st.id) AS count, v.capacity
     FROM transport_routes r LEFT JOIN student_transport st ON st.route_id = r.id AND st.status = 'active'
     LEFT JOIN transport_vehicles v ON v.id = r.vehicle_id
     WHERE r.school_id = $1 GROUP BY r.name, v.capacity ORDER BY r.name`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: r.capacity ? `${r.label} (of ${r.capacity} seats)` : r.label, count: Number(r.count) })));
}));

// ---- Inventory ----
router.get('/inventory/low-stock', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT name AS label, quantity AS count, reorder_level FROM inventory_items
     WHERE school_id = $1 AND quantity <= reorder_level ORDER BY quantity ASC`,
    [schoolId]
  );
  res.json(rows.map(r => ({ label: `${r.label} (reorder at ${r.reorder_level})`, count: Number(r.count) })));
}));

// ---- Health ----
router.get('/health/incidents', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT TO_CHAR(incident_date, 'YYYY-MM') AS label, COUNT(*) AS count
     FROM health_incidents WHERE school_id = $1 AND incident_date BETWEEN $2 AND $3
     GROUP BY label ORDER BY label`,
    [schoolId, from, to]
  );
  res.json({ from, to, breakdown: rows.map(r => ({ label: r.label, count: Number(r.count) })) });
}));

// ---- Events ----
router.get('/events/rsvp-summary', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!req.query.event_id) return res.status(400).json({ error: 'event_id is required' });
  const { rows } = await pool.query(
    `SELECT status, COUNT(*) AS count FROM event_rsvps WHERE school_id = $1 AND event_id = $2 GROUP BY status`,
    [schoolId, req.query.event_id]
  );
  res.json(rows.map(r => ({ label: r.status.replace(/_/g,' '), count: Number(r.count) })));
}));

// ---- Leave ----
router.get('/leave/summary', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT applicant_type, status, COUNT(*) AS count FROM leave_requests
     WHERE school_id = $1 AND from_date BETWEEN $2 AND $3
     GROUP BY applicant_type, status ORDER BY applicant_type, status`,
    [schoolId, from, to]
  );
  res.json({ from, to, breakdown: rows.map(r => ({ label: `${r.applicant_type} - ${r.status}`, count: Number(r.count) })) });
}));

module.exports = router;
