-- =====================================================================
-- School Management System - Core Schema
-- Multi-tenant (school_id scoping), RBAC, audit trail, versioned grading
--
-- This version is written to match public/index.html's actual API contract
-- field-for-field (column names, enums, and workflow states below were
-- reverse-engineered from what the frontend sends/reads), not the other
-- way around - the frontend was already built when this schema was revised.
-- =====================================================================

-- ---------- Tenancy ----------
CREATE TABLE IF NOT EXISTS schools (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  code          VARCHAR(20) UNIQUE NOT NULL,
  address       TEXT,
  phone         VARCHAR(30),
  email         VARCHAR(120),
  status        VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- RBAC ----------
CREATE TABLE IF NOT EXISTS roles (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) UNIQUE NOT NULL, -- super_admin, school_admin, principal, teacher, student, parent, accountant, librarian, nurse, transport_officer
  description   VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS permissions (
  id            SERIAL PRIMARY KEY,
  key           VARCHAR(100) UNIQUE NOT NULL,
  description   VARCHAR(200)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER REFERENCES schools(id) ON DELETE CASCADE, -- NULL for super_admin
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  username      VARCHAR(80) NOT NULL,
  email         VARCHAR(120) NOT NULL,
  password_hash VARCHAR(200) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'active', -- active, disabled
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER,
  UNIQUE (school_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_school ON users(school_id);

-- Sequential, gap-free numbering counters (one row per school per series).
-- admissionNumbers.js increments 'admission'; staff/invoice/receipt numbering
-- below reuse the same table with a different `series` value.
CREATE TABLE IF NOT EXISTS school_admission_counters (
  school_id     INTEGER PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  last_number   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS school_number_counters (
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  series        VARCHAR(30) NOT NULL, -- 'staff', 'invoice', 'receipt', 'inquiry'
  last_number   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (school_id, series)
);

-- ---------- Academic structure ----------
CREATE TABLE IF NOT EXISTS academic_years (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          VARCHAR(30) NOT NULL, -- e.g. 2026-2027
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  is_current    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER,
  UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ay_school ON academic_years(school_id);

-- `section` and `class_teacher` are a deliberately flat, single-value pair
-- alongside the fully relational `sections` table below. The UI's Classes
-- screen edits one class as one row (name + a single section + one teacher
-- name); the relational `sections` table remains available for anything that
-- needs true multi-section rosters (students.section_id, timetable, etc.).
CREATE TABLE IF NOT EXISTS classes (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id  INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name              VARCHAR(50) NOT NULL, -- Grade 1, Grade 2, ...
  section           VARCHAR(20),
  class_teacher     VARCHAR(150),
  capacity          INTEGER,
  status            VARCHAR(20) NOT NULL DEFAULT 'active', -- active, inactive, archived
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER,
  updated_by        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);

CREATE TABLE IF NOT EXISTS sections (
  id            SERIAL PRIMARY KEY,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name          VARCHAR(20) NOT NULL, -- A, B, C
  capacity      INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class_id, name)
);

CREATE TABLE IF NOT EXISTS subjects (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  code          VARCHAR(20),
  is_elective   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER,
  UNIQUE (school_id, code)
);
CREATE INDEX IF NOT EXISTS idx_subjects_school ON subjects(school_id);

-- ---------- People ----------
CREATE TABLE IF NOT EXISTS guardians (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL, -- links a 'parent' login to this guardian record
  name          VARCHAR(150) NOT NULL,
  relation      VARCHAR(30), -- father, mother, guardian
  phone         VARCHAR(30),
  email         VARCHAR(120),
  address       TEXT,
  occupation    VARCHAR(100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_guardians_school ON guardians(school_id);
CREATE INDEX IF NOT EXISTS idx_guardians_user ON guardians(user_id);

CREATE TABLE IF NOT EXISTS students (
  id              SERIAL PRIMARY KEY,
  school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  admission_no    VARCHAR(30) NOT NULL,
  first_name      VARCHAR(80) NOT NULL,
  last_name       VARCHAR(80) NOT NULL,
  dob             DATE,
  gender          VARCHAR(20),
  nationality     VARCHAR(80),
  previous_school VARCHAR(200),
  -- How this record originated, per spec's required dropdown:
  source          VARCHAR(20) NOT NULL DEFAULT 'direct_registration', -- admissions, transfer_student, returning_student, direct_registration
  admission_inquiry_id INTEGER, -- FK added below (admission_inquiries is defined later in this file)
  academic_year_id INTEGER REFERENCES academic_years(id), -- the year the student was enrolled/promoted into; may differ from class's own default year
  class_id        INTEGER REFERENCES classes(id), -- nullable: a student can exist before being placed in a class
  section_id      INTEGER REFERENCES sections(id),
  admission_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  health_info     TEXT,
  photo_url       TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active, graduated, transferred, withdrawn
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INTEGER,
  updated_by      INTEGER,
  UNIQUE (school_id, admission_no),
  CHECK (source IN ('admissions', 'transfer_student', 'returning_student', 'direct_registration'))
);
CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id, section_id);

-- Full year-by-year class history, per spec's explicit promotion-history requirement
-- (e.g. "2026-2027: Grade 1, 2027-2028: Grade 2, ..."). A row is written every time
-- a student is promoted, transferred, or repeats a year - see POST /students/promote.
CREATE TABLE IF NOT EXISTS student_class_history (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id        INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id  INTEGER NOT NULL REFERENCES academic_years(id),
  class_id          INTEGER REFERENCES classes(id),
  section_id        INTEGER REFERENCES sections(id),
  status            VARCHAR(20) NOT NULL DEFAULT 'promoted', -- promoted, repeated, transferred, enrolled
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_class_history_student ON student_class_history(student_id);

-- Generic file-upload metadata for both admission inquiries and student records
-- (spec: "Upload Documents" on both). Actual bytes live on disk under
-- UPLOADS_DIR/<school_id>/<owner_type>/<owner_id>/ - this table is just the index.
CREATE TABLE IF NOT EXISTS documents (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  owner_type    VARCHAR(30) NOT NULL, -- 'admission_inquiry' or 'student'
  owner_id      INTEGER NOT NULL,
  label         VARCHAR(100), -- e.g. 'Birth Certificate', 'Report Card', 'Passport Photo'
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL, -- randomized filename on disk, prevents path traversal / collisions
  mime_type     VARCHAR(100),
  size_bytes    INTEGER,
  uploaded_by   INTEGER,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (owner_type IN ('admission_inquiry', 'student'))
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS student_guardians (
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  guardian_id   INTEGER NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  relation      VARCHAR(30),
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (student_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS staff (
  id              SERIAL PRIMARY KEY,
  school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  employee_no     VARCHAR(30) NOT NULL,
  first_name      VARCHAR(80) NOT NULL,
  last_name       VARCHAR(80) NOT NULL,
  designation     VARCHAR(80), -- teacher, accountant, librarian, admin
  department      VARCHAR(80),
  hire_date       DATE,
  salary_basic    NUMERIC(12,2),
  phone           VARCHAR(30),
  email           VARCHAR(120),
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INTEGER,
  updated_by      INTEGER,
  UNIQUE (school_id, employee_no)
);
CREATE INDEX IF NOT EXISTS idx_staff_school ON staff(school_id);

-- ---------- Admissions ----------
-- Admissions captures full prospective-student demographics up front, per spec,
-- so nothing has to be re-typed when the applicant becomes a student (see
-- admission_inquiries -> students field mapping in src/routes/admissions.js).
CREATE TABLE IF NOT EXISTS admission_inquiries (
  id                       SERIAL PRIMARY KEY,
  school_id                INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  inquiry_no               VARCHAR(30) NOT NULL,
  first_name               VARCHAR(80) NOT NULL,
  last_name                VARCHAR(80) NOT NULL,
  dob                      DATE,
  gender                   VARCHAR(20),
  nationality              VARCHAR(80),
  address                  TEXT,
  city                     VARCHAR(100),
  state                    VARCHAR(100),
  country                  VARCHAR(100),
  previous_school          VARCHAR(200),
  class_applying_id        INTEGER REFERENCES classes(id),
  academic_year_applying_id INTEGER REFERENCES academic_years(id),
  parent_name              VARCHAR(150),
  relation                 VARCHAR(30), -- relationship to student (mother, father, guardian, ...)
  phone                    VARCHAR(30),
  email                    VARCHAR(120),
  emergency_contact_name   VARCHAR(150),
  emergency_contact_phone  VARCHAR(30),
  referral_source          VARCHAR(80), -- how the family heard about the school
  -- Exact status vocabulary from spec, including Waitlisted (previously missing):
  status                   VARCHAR(30) NOT NULL DEFAULT 'inquiry',
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, inquiry_no),
  CHECK (status IN ('inquiry', 'application_received', 'interview_scheduled', 'accepted', 'waitlisted', 'rejected', 'enrolled'))
);
CREATE INDEX IF NOT EXISTS idx_inquiries_school ON admission_inquiries(school_id);

-- Deferred: students.admission_inquiry_id references this table, which is defined
-- after students in this file, so the FK is added here instead of inline above.
DO $$ BEGIN
  ALTER TABLE students ADD CONSTRAINT fk_students_admission_inquiry
    FOREIGN KEY (admission_inquiry_id) REFERENCES admission_inquiries(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS admission_applications (
  id                  SERIAL PRIMARY KEY,
  inquiry_id          INTEGER NOT NULL REFERENCES admission_inquiries(id) ON DELETE CASCADE,
  entrance_test_score NUMERIC(6,2),
  interview_notes     TEXT,
  documents           JSONB DEFAULT '[]', -- [{name, url, uploaded_at}]
  seat_allotted       BOOLEAN NOT NULL DEFAULT false,
  enrolled_student_id INTEGER REFERENCES students(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Timetable ----------
CREATE TABLE IF NOT EXISTS teacher_subject_class (
  id                  SERIAL PRIMARY KEY,
  school_id           INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id            INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  subject_id          INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id            INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  section_id          INTEGER REFERENCES sections(id) ON DELETE CASCADE,
  academic_year_id    INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tsc_school ON teacher_subject_class(school_id);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  section_id    INTEGER REFERENCES sections(id) ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id),
  staff_id      INTEGER NOT NULL REFERENCES staff(id),
  day_of_week   SMALLINT NOT NULL, -- 0=Sunday .. 6=Saturday
  period_number SMALLINT NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_timetable_school ON timetable_entries(school_id);

-- ---------- Attendance ----------
CREATE TABLE IF NOT EXISTS attendance_statuses (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code          VARCHAR(20) NOT NULL, -- present, absent, late, half_day, excused, on_leave
  label         VARCHAR(50) NOT NULL,
  counts_present BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (school_id, code)
);

CREATE TABLE IF NOT EXISTS student_attendance (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status_id     INTEGER NOT NULL REFERENCES attendance_statuses(id),
  period_number SMALLINT, -- NULL = whole-day record
  remarks       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER,
  UNIQUE (student_id, attendance_date, period_number)
);
CREATE INDEX IF NOT EXISTS idx_student_att_school_date ON student_attendance(school_id, attendance_date);

CREATE TABLE IF NOT EXISTS staff_attendance (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status_id     INTEGER NOT NULL REFERENCES attendance_statuses(id),
  remarks       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER,
  UNIQUE (staff_id, attendance_date)
);
CREATE INDEX IF NOT EXISTS idx_staff_att_school_date ON staff_attendance(school_id, attendance_date);

CREATE TABLE IF NOT EXISTS leave_requests (
  id              SERIAL PRIMARY KEY,
  school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  applicant_type  VARCHAR(10) NOT NULL, -- student, staff
  applicant_id    INTEGER NOT NULL,
  from_date       DATE NOT NULL,
  to_date         DATE NOT NULL,
  reason          TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  approved_by     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);
CREATE INDEX IF NOT EXISTS idx_leave_school ON leave_requests(school_id);

-- ---------- Examinations & Grading ----------
CREATE TABLE IF NOT EXISTS exams (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id  INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  name              VARCHAR(100) NOT NULL, -- Midterm, Final, Unit Test 1
  class_id          INTEGER REFERENCES classes(id),
  class_name        VARCHAR(100), -- free-text fallback when a specific class_id isn't selected
  status            VARCHAR(20) NOT NULL DEFAULT 'scheduled', -- scheduled, ongoing, completed, cancelled
  start_date        DATE, -- exposed to the UI as "exam_date"
  end_date          DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exams_school ON exams(school_id);

CREATE TABLE IF NOT EXISTS exam_subjects (
  id            SERIAL PRIMARY KEY,
  exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  max_marks     NUMERIC(6,2) NOT NULL DEFAULT 100,
  passing_marks NUMERIC(6,2) NOT NULL DEFAULT 35,
  exam_date     DATE,
  UNIQUE (exam_id, subject_id)
);

CREATE TABLE IF NOT EXISTS grading_scales (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name              VARCHAR(80) NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  effective_from    DATE NOT NULL,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER,
  updated_by        INTEGER,
  UNIQUE (school_id, name, version)
);
CREATE INDEX IF NOT EXISTS idx_grading_scales_school ON grading_scales(school_id);

CREATE TABLE IF NOT EXISTS grade_bands (
  id                SERIAL PRIMARY KEY,
  grading_scale_id  INTEGER NOT NULL REFERENCES grading_scales(id) ON DELETE CASCADE,
  min_percent       NUMERIC(5,2) NOT NULL,
  max_percent       NUMERIC(5,2) NOT NULL,
  letter_grade      VARCHAR(5) NOT NULL,
  grade_point       NUMERIC(4,2),
  CHECK (max_percent >= min_percent)
);
CREATE INDEX IF NOT EXISTS idx_grade_bands_scale ON grade_bands(grading_scale_id);

CREATE TABLE IF NOT EXISTS marks (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  exam_subject_id   INTEGER NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
  student_id        INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  grading_scale_id  INTEGER REFERENCES grading_scales(id),
  marks_obtained    NUMERIC(6,2),
  is_absent         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER,
  updated_by        INTEGER,
  UNIQUE (exam_subject_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_marks_school ON marks(school_id);

-- ---------- Fees & Finance ----------
CREATE TABLE IF NOT EXISTS fee_structures (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id  INTEGER NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  class_id          INTEGER REFERENCES classes(id),
  fee_type          VARCHAR(80) NOT NULL,
  amount            NUMERIC(12,2) NOT NULL,
  frequency         VARCHAR(20) NOT NULL DEFAULT 'term',
  due_date          DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER,
  updated_by        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fee_structures_school ON fee_structures(school_id);

CREATE TABLE IF NOT EXISTS invoices (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id        INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  academic_year_id  INTEGER NOT NULL REFERENCES academic_years(id),
  invoice_no        VARCHAR(30) NOT NULL,
  total_amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid       NUMERIC(12,2) NOT NULL DEFAULT 0, -- reflects APPROVED payments only (see payments.status)
  due_date          DATE,
  status            VARCHAR(20) NOT NULL DEFAULT 'unpaid', -- unpaid, partial, paid, overdue, void
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, invoice_no)
);
CREATE INDEX IF NOT EXISTS idx_invoices_school ON invoices(school_id);
CREATE INDEX IF NOT EXISTS idx_invoices_student ON invoices(student_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id                SERIAL PRIMARY KEY,
  invoice_id        INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  fee_structure_id  INTEGER REFERENCES fee_structures(id),
  description       VARCHAR(150),
  amount            NUMERIC(12,2) NOT NULL,
  amount_paid       NUMERIC(12,2) NOT NULL DEFAULT 0 -- reflects APPROVED payments only
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- Three-stage payment workflow: record (stage 1) -> reconcile (stage 2) -> approve
-- (stage 3). Segregation of duties is enforced in src/routes/fees.js: the same
-- user can never fill two of the three roles for one payment. `status` moves
-- pending_reconciliation -> pending_approval -> approved, or -> flagged (a
-- reconciliation mismatch) -> back to pending_reconciliation via resubmit, or
-- -> voided (terminal, from any state, requires a reason).
CREATE TABLE IF NOT EXISTS payments (
  id                    SERIAL PRIMARY KEY,
  school_id             INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id            INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  invoice_id            INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  receipt_no            VARCHAR(30) NOT NULL,
  amount_paid           NUMERIC(12,2) NOT NULL,
  payment_method        VARCHAR(30) NOT NULL DEFAULT 'cash', -- cash, bank_transfer, cheque, card, online
  reference_number      VARCHAR(80), -- required for non-cash methods
  bank_name             VARCHAR(120), -- bank_transfer only
  payment_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  status                VARCHAR(30) NOT NULL DEFAULT 'pending_reconciliation',
  idempotency_key       VARCHAR(64) UNIQUE, -- client-generated; prevents duplicate submission on double-click/retry
  recorded_by           INTEGER REFERENCES users(id),
  reconciled_by         INTEGER REFERENCES users(id),
  reconciled_at         TIMESTAMPTZ,
  statement_reference   VARCHAR(80), -- what the reconciler actually saw on the bank statement / cash count
  approved_by           INTEGER REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  flag_reason           TEXT, -- set when reconciliation finds a mismatch
  voided_by             INTEGER REFERENCES users(id),
  voided_at             TIMESTAMPTZ,
  voided_reason         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, receipt_no),
  CHECK (status IN ('pending_reconciliation','pending_approval','approved','flagged','voided'))
);
CREATE INDEX IF NOT EXISTS idx_payments_school ON payments(school_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

-- A single payment can be split across multiple invoice items once approved.
CREATE TABLE IF NOT EXISTS payment_allocations (
  id                SERIAL PRIMARY KEY,
  payment_id        INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  invoice_item_id   INTEGER NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  amount_allocated  NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_alloc_item ON payment_allocations(invoice_item_id);

-- ---------- Expenses ----------
CREATE TABLE IF NOT EXISTS expense_categories (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
  id                  SERIAL PRIMARY KEY,
  school_id           INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  category_id         INTEGER REFERENCES expense_categories(id),
  description         VARCHAR(200) NOT NULL,
  amount              NUMERIC(12,2) NOT NULL,
  expense_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  receipt_reference    VARCHAR(80),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending_approval', -- pending_approval, approved, rejected
  recorded_by         INTEGER REFERENCES users(id),
  approved_by         INTEGER REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_school ON expenses(school_id);

-- ---------- Staff Performance ----------
CREATE TABLE IF NOT EXISTS staff_evaluations (
  id                       SERIAL PRIMARY KEY,
  school_id                INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id                 INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  review_period_start      DATE NOT NULL,
  review_period_end        DATE NOT NULL,
  overall_rating           NUMERIC(3,1) NOT NULL, -- 1.0 - 5.0
  strengths                TEXT,
  areas_for_improvement    TEXT,
  evaluated_by             INTEGER REFERENCES users(id),
  acknowledged_at          TIMESTAMPTZ, -- set when the staff member acknowledges the review
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (review_period_end >= review_period_start),
  CHECK (overall_rating BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_staff_evals_school ON staff_evaluations(school_id);
CREATE INDEX IF NOT EXISTS idx_staff_evals_staff ON staff_evaluations(staff_id);

-- ---------- Communication ----------
CREATE TABLE IF NOT EXISTS notices (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title         VARCHAR(200) NOT NULL,
  body          TEXT NOT NULL,
  audience      VARCHAR(20) DEFAULT 'all',
  posted_by     INTEGER REFERENCES users(id),
  posted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notices_school ON notices(school_id);

CREATE TABLE IF NOT EXISTS messages (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  sender_id     INTEGER NOT NULL REFERENCES users(id),
  recipient_id  INTEGER NOT NULL REFERENCES users(id),
  subject       VARCHAR(200),
  body          TEXT NOT NULL,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_messages_school ON messages(school_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);

-- ---------- Audit Trail ----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  school_id     INTEGER,
  table_name    VARCHAR(80) NOT NULL,
  record_id     INTEGER,
  action        VARCHAR(20) NOT NULL,
  changed_by    INTEGER,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_values    JSONB,
  new_values    JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_school ON audit_logs(school_id);
CREATE INDEX IF NOT EXISTS idx_audit_table_record ON audit_logs(table_name, record_id);

-- =====================================================================
-- Resource modules: Library, Transport, Health Records, Inventory, Events
-- =====================================================================

-- ---------- Library ----------
CREATE TABLE IF NOT EXISTS library_books (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title             VARCHAR(300) NOT NULL,
  author            VARCHAR(200),
  isbn              VARCHAR(30),
  category          VARCHAR(100),
  shelf_location    VARCHAR(50),
  copies_total      INTEGER NOT NULL DEFAULT 1,
  copies_available  INTEGER NOT NULL DEFAULT 1,
  status            VARCHAR(20) NOT NULL DEFAULT 'active', -- active, retired
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        INTEGER,
  updated_by        INTEGER,
  CHECK (copies_available >= 0 AND copies_available <= copies_total)
);
CREATE INDEX IF NOT EXISTS idx_library_books_school ON library_books(school_id);

-- Exactly one of student_id / staff_id is set, matching who borrowed the book.
CREATE TABLE IF NOT EXISTS book_loans (
  id             SERIAL PRIMARY KEY,
  school_id      INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  book_id        INTEGER NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  borrower_type  VARCHAR(10) NOT NULL, -- student, staff
  student_id     INTEGER REFERENCES students(id) ON DELETE CASCADE,
  staff_id       INTEGER REFERENCES staff(id) ON DELETE CASCADE,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date       DATE NOT NULL,
  returned_at    TIMESTAMPTZ,
  fine_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,
  status         VARCHAR(20) NOT NULL DEFAULT 'on_loan', -- on_loan, returned, lost
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INTEGER,
  updated_by     INTEGER,
  CHECK (borrower_type IN ('student', 'staff')),
  CHECK ((borrower_type = 'student' AND student_id IS NOT NULL AND staff_id IS NULL)
      OR (borrower_type = 'staff' AND staff_id IS NOT NULL AND student_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_book_loans_school ON book_loans(school_id);
CREATE INDEX IF NOT EXISTS idx_book_loans_book ON book_loans(book_id);
CREATE INDEX IF NOT EXISTS idx_book_loans_student ON book_loans(student_id);
CREATE INDEX IF NOT EXISTS idx_book_loans_staff ON book_loans(staff_id);

-- ---------- Transport ----------
CREATE TABLE IF NOT EXISTS transport_vehicles (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  vehicle_no    VARCHAR(30) NOT NULL,
  vehicle_type  VARCHAR(50),
  capacity      INTEGER,
  driver_name   VARCHAR(150),
  driver_phone  VARCHAR(30),
  status        VARCHAR(20) NOT NULL DEFAULT 'active', -- active, maintenance, retired
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER,
  UNIQUE (school_id, vehicle_no)
);
CREATE INDEX IF NOT EXISTS idx_transport_vehicles_school ON transport_vehicles(school_id);

CREATE TABLE IF NOT EXISTS transport_routes (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name          VARCHAR(150) NOT NULL,
  description   TEXT,
  vehicle_id    INTEGER REFERENCES transport_vehicles(id) ON DELETE SET NULL,
  fare_amount   NUMERIC(10,2),
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_transport_routes_school ON transport_routes(school_id);

CREATE TABLE IF NOT EXISTS transport_stops (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  route_id      INTEGER NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  name          VARCHAR(150) NOT NULL,
  sequence_no   INTEGER NOT NULL DEFAULT 0,
  pickup_time   TIME,
  drop_time     TIME,
  created_by    INTEGER,
  updated_by    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_transport_stops_route ON transport_stops(route_id);

CREATE TABLE IF NOT EXISTS student_transport (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  route_id      INTEGER NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  stop_id       INTEGER REFERENCES transport_stops(id) ON DELETE SET NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'active', -- active, ended
  start_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date      DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER,
  updated_by    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_student_transport_school ON student_transport(school_id);
CREATE INDEX IF NOT EXISTS idx_student_transport_student ON student_transport(student_id);

-- ---------- Health Records ----------
CREATE TABLE IF NOT EXISTS health_records (
  id                       SERIAL PRIMARY KEY,
  school_id                INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id               INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  blood_group              VARCHAR(10),
  allergies                TEXT,
  conditions               TEXT, -- ongoing/chronic conditions
  emergency_contact_name   VARCHAR(150),
  emergency_contact_phone  VARCHAR(30),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               INTEGER,
  updated_by               INTEGER,
  UNIQUE (student_id)
);
CREATE INDEX IF NOT EXISTS idx_health_records_school ON health_records(school_id);

CREATE TABLE IF NOT EXISTS vaccinations (
  id              SERIAL PRIMARY KEY,
  school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  vaccine_name    VARCHAR(150) NOT NULL,
  date_given      DATE,
  next_due_date   DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vaccinations_student ON vaccinations(student_id);

CREATE TABLE IF NOT EXISTS health_incidents (
  id                SERIAL PRIMARY KEY,
  school_id         INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id        INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  incident_date     TIMESTAMPTZ NOT NULL DEFAULT now(),
  description       TEXT NOT NULL,
  action_taken      TEXT,
  parent_notified   BOOLEAN NOT NULL DEFAULT false,
  reported_by       INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_incidents_school ON health_incidents(school_id);
CREATE INDEX IF NOT EXISTS idx_health_incidents_student ON health_incidents(student_id);

-- ---------- Inventory ----------
CREATE TABLE IF NOT EXISTS inventory_items (
  id                 SERIAL PRIMARY KEY,
  school_id          INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name               VARCHAR(200) NOT NULL,
  category           VARCHAR(100),
  sku                VARCHAR(50),
  unit               VARCHAR(20),
  quantity           INTEGER NOT NULL DEFAULT 0,
  reorder_level      INTEGER NOT NULL DEFAULT 0,
  unit_cost          NUMERIC(10,2),
  location           VARCHAR(150),
  status             VARCHAR(20) NOT NULL DEFAULT 'active', -- active, discontinued
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         INTEGER,
  updated_by         INTEGER,
  CHECK (quantity >= 0)
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_school ON inventory_items(school_id);

-- A signed ledger: positive `change` = stock in, negative = stock out/adjustment down.
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id             SERIAL PRIMARY KEY,
  school_id      INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  change         INTEGER NOT NULL, -- signed
  reason         VARCHAR(200),
  performed_by   INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (change <> 0)
);
CREATE INDEX IF NOT EXISTS idx_inventory_txn_school ON inventory_transactions(school_id);
CREATE INDEX IF NOT EXISTS idx_inventory_txn_item ON inventory_transactions(item_id);

-- ---------- Events ----------
CREATE TABLE IF NOT EXISTS events (
  id              SERIAL PRIMARY KEY,
  school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  event_type      VARCHAR(50) NOT NULL DEFAULT 'general', -- general, sports, club, competition
  event_date      DATE,
  start_datetime  TIMESTAMPTZ,
  end_datetime    TIMESTAMPTZ,
  location        VARCHAR(200),
  audience        VARCHAR(20) NOT NULL DEFAULT 'all', -- all, students, staff, parents, class
  class_id        INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'scheduled', -- scheduled, cancelled, completed
  is_published    BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      INTEGER,
  updated_by      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_school ON events(school_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);

CREATE TABLE IF NOT EXISTS event_rsvps (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'going', -- going, not_going, maybe
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_id);
