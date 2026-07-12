const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// Custom create: copies_available defaults to copies_total when the client only sends
// a starting count (the Add Book form's only quantity field) - registered before the
// generic CRUD router below so it wins on POST /books; GET/PUT/DELETE still fall
// through to the generic router afterward.
router.post('/books', authorize('library.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { title, author, isbn, category, shelf_location, copies_total, status } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const total = copies_total != null ? copies_total : 1;
  const available = req.body.copies_available != null ? req.body.copies_available : total;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO library_books (school_id, title, author, isbn, category, shelf_location, copies_total, copies_available, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'active'), $10, $10) RETURNING *`,
      [schoolId, title, author || null, isbn || null, category || null, shelf_location || null, total, available, status || null, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'library_books', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Registered before the generic CRUD mount below so this specific check runs
// first: a book currently checked out shouldn't be deletable, since book_loans
// cascades on book delete and would silently wipe out who has it and when it's
// due, not just the book's own catalog entry.
router.delete('/books/:id', authorize('library.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: activeLoans } = await pool.query(`SELECT id FROM book_loans WHERE book_id = $1 AND status = 'on_loan' LIMIT 1`, [req.params.id]);
  if (activeLoans[0]) {
    return res.status(409).json({ error: 'This book is currently on loan - it must be returned before it can be deleted' });
  }
  const { rows } = await pool.query('DELETE FROM library_books WHERE id = $1 AND school_id = $2 RETURNING *', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Book not found' });
  await logAudit(pool, { schoolId, tableName: 'library_books', recordId: rows[0].id, action: 'delete', changedBy: req.user.id, oldValues: rows[0], newValues: null }).catch(() => {});
  res.status(204).send();
}));

router.use('/books', buildCrudRouter({
  table: 'library_books',
  fields: ['title', 'author', 'isbn', 'category', 'shelf_location', 'copies_total', 'copies_available', 'status'],
  requiredOnCreate: ['title'],
  viewPermission: 'library.view',
  managePermission: 'library.manage',
  searchFields: ['title', 'author', 'isbn'],
  orderBy: 'title',
}));

const LOAN_SELECT = `
  SELECT bl.*, lb.title,
         st.first_name AS student_first_name, st.last_name AS student_last_name,
         sf.first_name AS staff_first_name, sf.last_name AS staff_last_name
  FROM book_loans bl
  JOIN library_books lb ON lb.id = bl.book_id
  LEFT JOIN students st ON st.id = bl.student_id
  LEFT JOIN staff sf ON sf.id = bl.staff_id`;

// ?status=on_loan (or omit for all)
router.get('/loans', authorize('library.view', 'library.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = 'bl.school_id = $1';
  if (req.query.status) { params.push(req.query.status); where += ` AND bl.status = $${params.length}`; }
  const { rows } = await pool.query(`${LOAN_SELECT} WHERE ${where} ORDER BY bl.issued_at DESC`, params);
  res.json(rows);
}));

// Issue a book: { book_id, borrower_type, student_id | staff_id, due_date? }
router.post('/loans', authorize('library.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { book_id, borrower_type, student_id, staff_id, due_date } = req.body;
  if (!book_id || !borrower_type) return res.status(400).json({ error: 'book_id and borrower_type are required' });
  if (!['student', 'staff'].includes(borrower_type)) return res.status(400).json({ error: "borrower_type must be 'student' or 'staff'" });
  if (borrower_type === 'student' && !student_id) return res.status(400).json({ error: 'student_id is required when borrower_type is student' });
  if (borrower_type === 'staff' && !staff_id) return res.status(400).json({ error: 'staff_id is required when borrower_type is staff' });
  const dueDate = due_date || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10); // default 2-week loan

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: bookRows } = await client.query('SELECT * FROM library_books WHERE id = $1 AND school_id = $2 FOR UPDATE', [book_id, schoolId]);
    if (!bookRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Book not found' }); }
    if (bookRows[0].copies_available < 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No available copies of this book' });
    }
    await client.query('UPDATE library_books SET copies_available = copies_available - 1, updated_at = now(), updated_by = $1 WHERE id = $2', [req.user.id, book_id]);
    const { rows: loanRows } = await client.query(
      `INSERT INTO book_loans (school_id, book_id, borrower_type, student_id, staff_id, due_date, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [schoolId, book_id, borrower_type, borrower_type === 'student' ? student_id : null, borrower_type === 'staff' ? staff_id : null, dueDate, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'book_loans', recordId: loanRows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: loanRows[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${LOAN_SELECT} WHERE bl.id = $1`, [loanRows[0].id]);
    res.status(201).json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// POST /library/loans/:id/return
router.post('/loans/:id/return', authorize('library.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: loanRows } = await client.query('SELECT * FROM book_loans WHERE id = $1 AND school_id = $2 FOR UPDATE', [req.params.id, schoolId]);
    if (!loanRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Loan not found' }); }
    if (loanRows[0].status === 'returned') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This loan was already returned' });
    }
    const fineAmount = req.body.fine_amount != null ? req.body.fine_amount : loanRows[0].fine_amount;
    const { rows: updatedLoan } = await client.query(
      `UPDATE book_loans SET status = 'returned', returned_at = now(), fine_amount = $1, updated_at = now(), updated_by = $2
       WHERE id = $3 RETURNING *`,
      [fineAmount, req.user.id, req.params.id]
    );
    await client.query('UPDATE library_books SET copies_available = copies_available + 1, updated_at = now(), updated_by = $1 WHERE id = $2', [req.user.id, loanRows[0].book_id]);
    await logAudit(client, { schoolId, tableName: 'book_loans', recordId: updatedLoan[0].id, action: 'update', changedBy: req.user.id, oldValues: loanRows[0], newValues: updatedLoan[0] });
    await client.query('COMMIT');
    const { rows: full } = await pool.query(`${LOAN_SELECT} WHERE bl.id = $1`, [updatedLoan[0].id]);
    res.json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
