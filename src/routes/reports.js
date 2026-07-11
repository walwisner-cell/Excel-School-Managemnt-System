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
   One endpoint per report, organized by module. Every report returns both a
   `summary` (the bars/totals) AND a `detail` array of the actual underlying
   records - real student names, real payment amounts, real dates - so a report
   is something you can actually act on, not just a count you have to go verify
   by hand elsewhere. */

// ---- Students ----
router.get('/students/by-class', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT s.id, s.first_name, s.last_name, s.admission_no, s.gender, COALESCE(c.name, 'Unassigned') AS class_name, c.sort_order
     FROM students s LEFT JOIN classes c ON c.id = s.class_id
     WHERE s.school_id = $1 AND s.status = 'active'
     ORDER BY c.sort_order NULLS LAST, s.last_name`,
    [schoolId]
  );
  const byClass = {};
  rows.forEach(r => { (byClass[r.class_name] ||= []).push(r); });
  res.json({
    summary: Object.entries(byClass).map(([label, list]) => ({ label, count: list.length })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, admissionNo: r.admission_no, gender: r.gender || '-', className: r.class_name })),
  });
}));

router.get('/students/by-status', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT s.id, s.first_name, s.last_name, s.admission_no, s.status, COALESCE(c.name,'Unassigned') AS class_name
     FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.school_id = $1 ORDER BY s.status, s.last_name`,
    [schoolId]
  );
  const byStatus = {};
  rows.forEach(r => { (byStatus[r.status] ||= []).push(r); });
  res.json({
    summary: Object.entries(byStatus).map(([label, list]) => ({ label, count: list.length })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, admissionNo: r.admission_no, status: r.status, className: r.class_name })),
  });
}));

router.get('/students/demographics', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT s.first_name, s.last_name, s.admission_no, s.gender, s.nationality, s.dob, COALESCE(c.name,'Unassigned') AS class_name
     FROM students s LEFT JOIN classes c ON c.id = s.class_id WHERE s.school_id = $1 AND s.status = 'active' ORDER BY s.last_name`,
    [schoolId]
  );
  const byGender = {}, byNationality = {};
  rows.forEach(r => {
    const g = r.gender || 'Not recorded'; byGender[g] = (byGender[g]||0) + 1;
    const n = r.nationality || 'Not recorded'; byNationality[n] = (byNationality[n]||0) + 1;
  });
  const age = (dob) => dob ? Math.floor((Date.now() - new Date(dob).getTime()) / (365.25*24*60*60*1000)) : null;
  res.json({
    byGender: Object.entries(byGender).map(([label,count]) => ({ label, count })),
    byNationality: Object.entries(byNationality).map(([label,count]) => ({ label, count })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, admissionNo: r.admission_no, gender: r.gender||'-', nationality: r.nationality||'-', age: age(r.dob) ?? '-', className: r.class_name })),
  });
}));

// ---- Admissions ----
router.get('/admissions/by-status', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT first_name, last_name, status, referral_source, created_at, parent_name, phone
     FROM admission_inquiries WHERE school_id = $1 ORDER BY status, created_at DESC`,
    [schoolId]
  );
  const byStatus = {};
  rows.forEach(r => { (byStatus[r.status] ||= []).push(r); });
  res.json({
    summary: Object.entries(byStatus).map(([label, list]) => ({ label: label.replace(/_/g,' '), count: list.length })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, status: r.status.replace(/_/g,' '), parentName: r.parent_name||'-', phone: r.phone||'-', date: (r.created_at||'').toString().slice(0,10) })),
  });
}));

router.get('/admissions/by-source', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT first_name, last_name, COALESCE(referral_source,'not_recorded') AS referral_source, status, created_at
     FROM admission_inquiries WHERE school_id = $1 ORDER BY referral_source, created_at DESC`,
    [schoolId]
  );
  const bySource = {};
  rows.forEach(r => { (bySource[r.referral_source] ||= []).push(r); });
  res.json({
    summary: Object.entries(bySource).map(([label, list]) => ({ label: label.replace(/_/g,' '), count: list.length })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, source: r.referral_source.replace(/_/g,' '), status: r.status.replace(/_/g,' '), date: (r.created_at||'').toString().slice(0,10) })),
  });
}));

// ---- Staff ----
router.get('/staff/by-designation', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT first_name, last_name, employee_no, COALESCE(designation,'Not recorded') AS designation, department, email, phone
     FROM staff WHERE school_id = $1 AND status = 'active' ORDER BY designation, last_name`,
    [schoolId]
  );
  const byDesignation = {};
  rows.forEach(r => { (byDesignation[r.designation] ||= []).push(r); });
  res.json({
    summary: Object.entries(byDesignation).map(([label, list]) => ({ label, count: list.length })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, employeeNo: r.employee_no, designation: r.designation, department: r.department||'-', email: r.email||'-', phone: r.phone||'-' })),
  });
}));

router.get('/staff/by-department', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT first_name, last_name, employee_no, designation, COALESCE(department,'Not recorded') AS department, email, phone
     FROM staff WHERE school_id = $1 AND status = 'active' ORDER BY department, last_name`,
    [schoolId]
  );
  const byDept = {};
  rows.forEach(r => { (byDept[r.department] ||= []).push(r); });
  res.json({
    summary: Object.entries(byDept).map(([label, list]) => ({ label, count: list.length })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, employeeNo: r.employee_no, designation: r.designation||'-', department: r.department, email: r.email||'-', phone: r.phone||'-' })),
  });
}));

// ---- Attendance ----
// ?from=&to=&class_id= (all optional - defaults to the last 30 days, whole school)
// Detail is PER-STUDENT attendance rate over the range - who specifically is
// missing school, not just a whole-school total that hides which students need
// follow-up.
router.get('/attendance/students', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const params = [schoolId, from, to];
  let where = 'sa.school_id = $1 AND sa.attendance_date BETWEEN $2 AND $3 AND sa.period_number IS NULL';
  if (req.query.class_id) { params.push(req.query.class_id); where += ` AND s.class_id = $${params.length}`; }
  const [summary, perStudent] = await Promise.all([
    pool.query(
      `SELECT ast.label, COUNT(*) AS count
       FROM student_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id JOIN students s ON s.id = sa.student_id
       WHERE ${where} GROUP BY ast.label ORDER BY ast.label`,
      params
    ),
    pool.query(
      `SELECT s.first_name, s.last_name, s.admission_no, COALESCE(c.name,'Unassigned') AS class_name,
              COUNT(*) FILTER (WHERE ast.counts_present) AS present_days,
              COUNT(*) AS total_days
       FROM student_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
       JOIN students s ON s.id = sa.student_id LEFT JOIN classes c ON c.id = s.class_id
       WHERE ${where} GROUP BY s.id, s.first_name, s.last_name, s.admission_no, c.name ORDER BY (COUNT(*) FILTER (WHERE ast.counts_present))::float / NULLIF(COUNT(*),0) ASC`,
      params
    ),
  ]);
  res.json({
    from, to,
    summary: summary.rows.map(r => ({ label: r.label, count: Number(r.count) })),
    detail: perStudent.rows.map(r => ({
      name: `${r.first_name} ${r.last_name}`, admissionNo: r.admission_no, className: r.class_name,
      presentDays: Number(r.present_days), totalDays: Number(r.total_days),
      rate: r.total_days > 0 ? Math.round((r.present_days / r.total_days) * 100) : null,
    })),
  });
}));

router.get('/attendance/staff', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const [summary, perStaff] = await Promise.all([
    pool.query(
      `SELECT ast.label, COUNT(*) AS count FROM staff_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id
       WHERE sa.school_id = $1 AND sa.attendance_date BETWEEN $2 AND $3 GROUP BY ast.label ORDER BY ast.label`,
      [schoolId, from, to]
    ),
    pool.query(
      `SELECT st.first_name, st.last_name, st.employee_no,
              COUNT(*) FILTER (WHERE ast.counts_present) AS present_days, COUNT(*) AS total_days
       FROM staff_attendance sa JOIN attendance_statuses ast ON ast.id = sa.status_id JOIN staff st ON st.id = sa.staff_id
       WHERE sa.school_id = $1 AND sa.attendance_date BETWEEN $2 AND $3
       GROUP BY st.id, st.first_name, st.last_name, st.employee_no ORDER BY (COUNT(*) FILTER (WHERE ast.counts_present))::float / NULLIF(COUNT(*),0) ASC`,
      [schoolId, from, to]
    ),
  ]);
  res.json({
    from, to,
    summary: summary.rows.map(r => ({ label: r.label, count: Number(r.count) })),
    detail: perStaff.rows.map(r => ({
      name: `${r.first_name} ${r.last_name}`, employeeNo: r.employee_no,
      presentDays: Number(r.present_days), totalDays: Number(r.total_days),
      rate: r.total_days > 0 ? Math.round((r.present_days / r.total_days) * 100) : null,
    })),
  });
}));

// ---- Academics ----
// ?exam_id= required - per-subject aggregate AND full per-student marks list
router.get('/academics/exam-performance', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!req.query.exam_id) return res.status(400).json({ error: 'exam_id is required' });
  const [summary, detail] = await Promise.all([
    pool.query(
      `SELECT sub.name AS subject_name, es.max_marks, es.passing_marks,
              COUNT(m.id) AS entries,
              ROUND(AVG(m.marks_obtained) FILTER (WHERE NOT m.is_absent), 1) AS average_marks,
              COUNT(*) FILTER (WHERE m.marks_obtained >= es.passing_marks AND NOT m.is_absent) AS passed,
              COUNT(*) FILTER (WHERE m.is_absent) AS absent
       FROM exam_subjects es JOIN subjects sub ON sub.id = es.subject_id JOIN exams e ON e.id = es.exam_id
       LEFT JOIN marks m ON m.exam_subject_id = es.id
       WHERE es.exam_id = $1 AND e.school_id = $2 GROUP BY sub.name, es.max_marks, es.passing_marks`,
      [req.query.exam_id, schoolId]
    ),
    pool.query(
      `SELECT s.first_name, s.last_name, s.admission_no, sub.name AS subject_name, es.max_marks,
              m.marks_obtained, m.is_absent, gb.letter_grade
       FROM marks m JOIN exam_subjects es ON es.id = m.exam_subject_id JOIN subjects sub ON sub.id = es.subject_id
       JOIN students s ON s.id = m.student_id JOIN exams e ON e.id = es.exam_id
       LEFT JOIN grade_bands gb ON gb.grading_scale_id = m.grading_scale_id
         AND m.marks_obtained IS NOT NULL AND es.max_marks > 0
         AND (m.marks_obtained / es.max_marks * 100) BETWEEN gb.min_percent AND gb.max_percent
       WHERE es.exam_id = $1 AND e.school_id = $2 ORDER BY s.last_name, sub.name`,
      [req.query.exam_id, schoolId]
    ),
  ]);
  res.json({
    summary: summary.rows.map(r => ({
      subject: r.subject_name, maxMarks: Number(r.max_marks), passingMarks: Number(r.passing_marks),
      entries: Number(r.entries), averageMarks: r.average_marks ? Number(r.average_marks) : null,
      passed: Number(r.passed), absent: Number(r.absent),
    })),
    detail: detail.rows.map(r => ({
      name: `${r.first_name} ${r.last_name}`, admissionNo: r.admission_no, subject: r.subject_name,
      marks: r.is_absent ? 'Absent' : `${r.marks_obtained} / ${r.max_marks}`, grade: r.letter_grade || '-',
    })),
  });
}));

// ---- Fees ----
// ?from=&to= (defaults to current month) - approved payments only, grouped by
// currency/method for the summary, full individual payment list for detail.
router.get('/fees/collections', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const [summary, detail] = await Promise.all([
    pool.query(
      `SELECT currency, payment_method, COUNT(*) AS count, SUM(amount_paid) AS total
       FROM payments WHERE school_id = $1 AND status = 'approved' AND payment_date BETWEEN $2 AND $3
       GROUP BY currency, payment_method ORDER BY currency, payment_method`,
      [schoolId, from, to]
    ),
    pool.query(
      `SELECT p.receipt_no, s.first_name, s.last_name, p.amount_paid, p.currency, p.payment_method, p.payment_date
       FROM payments p JOIN students s ON s.id = p.student_id
       WHERE p.school_id = $1 AND p.status = 'approved' AND p.payment_date BETWEEN $2 AND $3
       ORDER BY p.payment_date DESC`,
      [schoolId, from, to]
    ),
  ]);
  res.json({
    from, to,
    summary: summary.rows.map(r => ({ currency: r.currency, method: r.payment_method, count: Number(r.count), total: Number(r.total) })),
    detail: detail.rows.map(r => ({
      receiptNo: r.receipt_no, name: `${r.first_name} ${r.last_name}`, amount: Number(r.amount_paid),
      currency: r.currency, method: r.payment_method, date: (r.payment_date||'').toString().slice(0,10),
    })),
  });
}));

router.get('/fees/outstanding-by-class', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT i.invoice_no, s.first_name, s.last_name, COALESCE(c.name,'Unassigned') AS class_name,
            i.total_amount, i.amount_paid, i.currency
     FROM invoices i JOIN students s ON s.id = i.student_id LEFT JOIN classes c ON c.id = s.class_id
     WHERE i.school_id = $1 AND i.status IN ('unpaid','partial','overdue')
     ORDER BY c.sort_order NULLS LAST, (i.total_amount - i.amount_paid) DESC`,
    [schoolId]
  );
  const byClass = {};
  rows.forEach(r => {
    const key = `${r.class_name} (${r.currency})`;
    byClass[key] = (byClass[key] || 0) + (Number(r.total_amount) - Number(r.amount_paid));
  });
  res.json({
    summary: Object.entries(byClass).map(([label, count]) => ({ label, count: Math.round(count*100)/100 })),
    detail: rows.map(r => ({
      invoiceNo: r.invoice_no, name: `${r.first_name} ${r.last_name}`, className: r.class_name, currency: r.currency,
      total: Number(r.total_amount), paid: Number(r.amount_paid), outstanding: Number(r.total_amount) - Number(r.amount_paid),
    })),
  });
}));

router.get('/fees/expenses-by-category', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT e.description, COALESCE(ec.name,'Uncategorized') AS category, e.amount, e.currency, e.expense_date
     FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
     WHERE e.school_id = $1 AND e.status = 'approved' AND e.expense_date BETWEEN $2 AND $3
     ORDER BY e.expense_date DESC`,
    [schoolId, from, to]
  );
  const byCategory = {};
  rows.forEach(r => {
    const key = `${r.category} (${r.currency})`;
    byCategory[key] = (byCategory[key] || 0) + Number(r.amount);
  });
  res.json({
    from, to,
    summary: Object.entries(byCategory).map(([label, count]) => ({ label, count: Math.round(count*100)/100 })),
    detail: rows.map(r => ({ description: r.description, category: r.category, amount: Number(r.amount), currency: r.currency, date: (r.expense_date||'').toString().slice(0,10) })),
  });
}));

// ---- Library ----
router.get('/library/circulation', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const [summary, overdue] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) AS count FROM book_loans WHERE school_id = $1 GROUP BY status`, [schoolId]),
    pool.query(
      `SELECT b.title, COALESCE(s.first_name || ' ' || s.last_name, st.first_name || ' ' || st.last_name) AS borrower,
              bl.due_date, (CURRENT_DATE - bl.due_date) AS days_overdue
       FROM book_loans bl JOIN library_books b ON b.id = bl.book_id
       LEFT JOIN students s ON s.id = bl.student_id LEFT JOIN staff st ON st.id = bl.staff_id
       WHERE bl.school_id = $1 AND bl.status = 'on_loan' AND bl.due_date < CURRENT_DATE
       ORDER BY bl.due_date ASC`,
      [schoolId]
    ),
  ]);
  res.json({
    summary: summary.rows.map(r => ({ label: r.status.replace(/_/g,' '), count: Number(r.count) })),
    overdueCount: overdue.rows.length,
    detail: overdue.rows.map(r => ({ book: r.title, borrower: r.borrower || '-', dueDate: (r.due_date||'').toString().slice(0,10), daysOverdue: Number(r.days_overdue) })),
  });
}));

router.get('/library/most-borrowed', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT b.title, b.author, b.copies_total, b.copies_available, COUNT(bl.id) AS count
     FROM library_books b LEFT JOIN book_loans bl ON bl.book_id = b.id AND bl.school_id = $1
     WHERE b.school_id = $1 GROUP BY b.id, b.title, b.author, b.copies_total, b.copies_available
     ORDER BY COUNT(bl.id) DESC LIMIT 15`,
    [schoolId]
  );
  res.json({
    summary: rows.map(r => ({ label: r.title, count: Number(r.count) })),
    detail: rows.map(r => ({ title: r.title, author: r.author||'-', copiesTotal: r.copies_total, copiesAvailable: r.copies_available, timesBorrowed: Number(r.count) })),
  });
}));

// ---- Transport ----
router.get('/transport/route-utilization', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const [summary, detail] = await Promise.all([
    pool.query(
      `SELECT r.name AS label, COUNT(st.id) AS count, v.capacity
       FROM transport_routes r LEFT JOIN student_transport st ON st.route_id = r.id AND st.status = 'active'
       LEFT JOIN transport_vehicles v ON v.id = r.vehicle_id
       WHERE r.school_id = $1 GROUP BY r.name, v.capacity ORDER BY r.name`,
      [schoolId]
    ),
    pool.query(
      `SELECT r.name AS route_name, s.first_name, s.last_name, s.admission_no
       FROM student_transport st JOIN transport_routes r ON r.id = st.route_id JOIN students s ON s.id = st.student_id
       WHERE r.school_id = $1 AND st.status = 'active' ORDER BY r.name, s.last_name`,
      [schoolId]
    ),
  ]);
  res.json({
    summary: summary.rows.map(r => ({ label: r.capacity ? `${r.label} (of ${r.capacity} seats)` : r.label, count: Number(r.count) })),
    detail: detail.rows.map(r => ({ route: r.route_name, name: `${r.first_name} ${r.last_name}`, admissionNo: r.admission_no })),
  });
}));

// ---- Inventory ----
router.get('/inventory/low-stock', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT name, category, sku, quantity, reorder_level, unit, location FROM inventory_items
     WHERE school_id = $1 AND quantity <= reorder_level ORDER BY quantity ASC`,
    [schoolId]
  );
  res.json({
    summary: rows.map(r => ({ label: `${r.name} (reorder at ${r.reorder_level})`, count: Number(r.quantity) })),
    detail: rows.map(r => ({ name: r.name, category: r.category||'-', sku: r.sku||'-', quantity: r.quantity, reorderLevel: r.reorder_level, unit: r.unit||'-', location: r.location||'-' })),
  });
}));

// ---- Health ----
router.get('/health/incidents', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT hi.incident_date, hi.description, hi.action_taken, hi.parent_notified, s.first_name, s.last_name
     FROM health_incidents hi JOIN students s ON s.id = hi.student_id
     WHERE hi.school_id = $1 AND hi.incident_date BETWEEN $2 AND $3 ORDER BY hi.incident_date DESC`,
    [schoolId, from, to]
  );
  const byMonth = {};
  rows.forEach(r => {
    const m = (r.incident_date||'').toString().slice(0,7);
    byMonth[m] = (byMonth[m]||0) + 1;
  });
  res.json({
    from, to,
    summary: Object.entries(byMonth).sort().map(([label, count]) => ({ label, count })),
    detail: rows.map(r => ({ name: `${r.first_name} ${r.last_name}`, date: (r.incident_date||'').toString().slice(0,10), description: r.description, actionTaken: r.action_taken||'-', parentNotified: r.parent_notified ? 'Yes' : 'No' })),
  });
}));

// ---- Events ----
router.get('/events/rsvp-summary', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  if (!req.query.event_id) return res.status(400).json({ error: 'event_id is required' });
  const { rows } = await pool.query(
    `SELECT u.email, er.status, er.created_at FROM event_rsvps er JOIN users u ON u.id = er.user_id
     WHERE er.school_id = $1 AND er.event_id = $2 ORDER BY er.created_at`,
    [schoolId, req.query.event_id]
  );
  const byStatus = {};
  rows.forEach(r => { byStatus[r.status] = (byStatus[r.status]||0) + 1; });
  res.json({
    summary: Object.entries(byStatus).map(([label, count]) => ({ label: label.replace(/_/g,' '), count })),
    detail: rows.map(r => ({ email: r.email, status: r.status.replace(/_/g,' '), date: (r.created_at||'').toString().slice(0,10) })),
  });
}));

// ---- Leave ----
// Defaults to a window spanning 30 days back through 90 days ahead, since leave
// requests are almost always about UPCOMING dates, not past ones - a backward-only
// default would miss most real leave requests entirely.
router.get('/leave/summary', asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const from = req.query.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
  const to = req.query.to || new Date(Date.now() + 90*24*60*60*1000).toISOString().slice(0,10);
  const { rows } = await pool.query(
    `SELECT lr.applicant_type, lr.from_date, lr.to_date, lr.reason, lr.status,
            CASE WHEN lr.applicant_type = 'student' THEN s.first_name ELSE st.first_name END AS first_name,
            CASE WHEN lr.applicant_type = 'student' THEN s.last_name ELSE st.last_name END AS last_name
     FROM leave_requests lr
     LEFT JOIN students s ON s.id = lr.applicant_id AND lr.applicant_type = 'student'
     LEFT JOIN staff st ON st.id = lr.applicant_id AND lr.applicant_type = 'staff'
     WHERE lr.school_id = $1 AND lr.from_date BETWEEN $2 AND $3 ORDER BY lr.from_date DESC`,
    [schoolId, from, to]
  );
  const byGroup = {};
  rows.forEach(r => {
    const key = `${r.applicant_type} - ${r.status}`;
    byGroup[key] = (byGroup[key]||0) + 1;
  });
  res.json({
    from, to,
    summary: Object.entries(byGroup).map(([label, count]) => ({ label, count })),
    detail: rows.map(r => ({ name: `${r.first_name||'-'} ${r.last_name||''}`.trim(), type: r.applicant_type, from: (r.from_date||'').toString().slice(0,10), to: (r.to_date||'').toString().slice(0,10), reason: r.reason||'-', status: r.status })),
  });
}));

module.exports = router;
