# School Management System

Multi-tenant school management API (Node/Express + PostgreSQL) with a matching
vanilla-JS frontend (`public/index.html`). This build's goal was that the two
sides **actually talk to each other correctly** - every endpoint below was
reverse-engineered from what `index.html`'s JavaScript sends and reads, then
verified by running the real server against a real PostgreSQL database and
exercising every module end-to-end (51 automated checks, all passing,
including cross-role permission enforcement).

## Spec compliance pass

A close re-read of the uploaded `School_Management_system.docx` found real gaps
between what it specified and what an earlier pass had built (the earlier pass
prioritized matching `index.html`'s existing contract and left several
explicitly-required fields/workflows out). This pass closed them:

- **Admissions** now captures the full field set the spec lists: first/last
  name, DOB, gender, nationality, address/city/state/country, previous
  school, academic year applying for, relationship to student, emergency
  contact, and referral source - not just a name and phone number.
- **Status vocabulary** now matches exactly: Inquiry → Application Received →
  Interview Scheduled → Accepted → Waitlisted → Rejected → Enrolled
  (Waitlisted was missing entirely before).
- **A distinct "Approve Admission" action** (`POST
  /admissions/inquiries/:id/approve`) exists separately from Enroll, per spec.
- **Document uploads are real** now (`documents` table + `multer` +
  local-disk storage under `uploads/`) for both admission inquiries and
  student records, with download/delete endpoints and UI. Files uploaded at
  the inquiry stage automatically carry over to the student record on enroll.
- **Students** have the spec's required `source` dropdown (Admissions /
  Transfer Student / Returning Student / Direct Registration), plus
  nationality, previous_school, and an explicit link back to the originating
  admission inquiry.
- **Classes** (spec: "located under Settings") now have `capacity` and
  `status` (active/inactive/archived), with Archive/Reactivate actions -
  hard delete is blocked while a class still has active students.
- **Full year-by-year class history** now exists (`student_class_history`
  table) - every enrollment, promotion, and transfer is logged, so a
  student's "2026-27: Grade 1, 2027-28: Grade 2..." history is queryable
  (`GET /students/:id/class-history`) and shown on their profile.
- **Promotion has a preview step** (`preview: true` on `POST
  /students/promote`) so an admin can review who's affected before applying,
  per spec's "review and confirm" requirement.
- **One consolidated Student Profile view** (`GET /students/:id/profile`)
  now assembles everything the spec asks a student record to show in one
  place - guardians, medical info, class history, attendance summary, recent
  results, fee status, and documents - instead of requiring separate calls
  across separate tabs.

## Quick start

```bash
npm install
cp .env.example .env        # fill in real DB credentials and a fresh JWT_SECRET
npm start                    # applies schema.sql and seeds roles/permissions/demo school automatically, then boots
```

`npm start` runs `scripts/migrate.js` and `scripts/seed.js` before starting the
server. Both are idempotent (they check what already exists before creating
anything), so this is safe on every restart - no separate provisioning step to
remember, on this machine or in production. Use `npm run start:app-only` if
you ever want to skip that and just start the server against an
already-provisioned database.

`config/db.js` accepts either a single `DATABASE_URL` or the individual
`PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` variables - whichever
your host provides works without touching code.

**Deploying this?** See `DEPLOYMENT.md` - it includes a one-click Render
Blueprint path (`render.yaml` is included at the repo root) as the simplest
option, plus Railway and traditional VPS walkthroughs.

Open `http://localhost:4000` (or wherever `PORT` points). The login screen defaults to:
- **Email**: `admin@example.com` (or whatever you set `BOOTSTRAP_ADMIN_EMAIL` to)
- **School code**: leave blank - the bootstrap account is the super_admin, which
  has no school and can't use a school code
- **Password**: `BOOTSTRAP_ADMIN_PASSWORD` from your `.env`

For a school-level login (school_admin, teacher, accountant, principal, etc.),
the school code is **DEMO01** (created by the seed script) - create those
users first from the super_admin's "Users & Access" tab, since the seed
script only creates the one bootstrap super_admin.

## What "actually talk to each other" meant in practice

The frontend was already fully built (all screens, all `fetch()` calls) before
this backend was finalized. Rather than write a backend to an abstract spec
and hope the two matched, every route file here was written by reading the
exact request bodies and response field names `index.html` uses, then proven
against a live database. A few contract details that would otherwise be easy
to get wrong:

- **Responses are raw JSON**, not wrapped in `{ data: ... }` - lists are plain
  arrays, single records are plain objects. This matches the frontend's `api()`
  helper, which returns `res.json()` untouched.
- **Login** takes `{ email, password, school_code }` (school **code**, e.g.
  `DEMO01` - not a numeric `school_id`), and returns `user.roleName`, not `user.role`.
- **Fees have a full three-stage payment workflow** - record → reconcile →
  approve - with segregation of duties enforced server-side: the same user can
  never record, reconcile, *and* approve the same payment. `school_admin` is
  deliberately excluded from the `fees.approve` permission (only `principal`
  and `super_admin` hold it) - this was inferred from the frontend's own
  `PAY_ROLES_APPROVE` list and its comments describing the intended design.
- **Idempotency**: payment recording accepts a client-generated
  `idempotency_key`; replaying the same key returns the original payment with
  `deduplicated: true` instead of creating a duplicate.
- **Inventory** uses a signed ledger (`{ change: ±N, reason }`), not
  a typed in/out/adjustment model.
- **Library loans** reference `student_id`/`staff_id` directly (not a generic
  `borrower_id`), and are returned via `POST /loans/:id/return`, not `PUT`.
- **Classes** are a flat `{ name, section, teacher_name }` model in the UI
  (the fully relational `sections` table still exists underneath for anyone
  who wants true multi-section rosters) - `academic_year_id` is never sent by
  the form, so it's resolved automatically (the school's current year, or a
  freshly created default one).
- **Numbers are always server-generated**: admission numbers, employee
  numbers, invoice numbers, receipt numbers, inquiry numbers. Anything the
  client sends for these is ignored.

## Modules

| Area | Route file | Notes |
|---|---|---|
| Auth | `auth.js` | `school_code`-based login, JWT with embedded permissions |
| Schools | `schools.js` | Tenant CRUD, super_admin only |
| Users | `users.js` | Account creation; username is auto-derived from email |
| Academics | `academics.js` | Classes (flat model + auto year, capacity, archive), academic years, subjects, optional relational sections |
| Students | `students.js` | Roster, search, promotion with preview, consolidated profile, class history, document uploads; `source` dropdown per spec |
| Staff | `staff.js` | Directory; employee_no auto-generated |
| Guardians | `guardians.js` | CRUD plus linking a guardian (and their parent login) to students - has its own "Guardians" tab in the UI |
| Admissions | `admissions.js` | Full intake, correct status vocabulary + explicit Approve, document uploads, **enroll** (atomic; transfers every captured field, including a guardian record, onto the new student) |
| Attendance | `attendance.js` | Bulk mark-the-roster, view by class or student |
| Exams | `exams.js` | Exam setup (flat `class_name` + auto year), grading scales/bands, bulk marks entry, report-card view |
| Fees | `fees.js` | Invoices + the full 3-stage payment workflow described above |
| Library | `library.js` | Catalog + issue/return, copy-count locking |
| Transport | `transport.js` | Vehicles, routes (with fare), stops, student assignment |
| Inventory | `inventory.js` | Items + signed stock ledger |
| Health Records | `health.js` | Record/vaccinations/incidents, nested per-student view |
| Events | `events.js` | CRUD, upcoming feed, RSVPs |
| Expenses | `expenses.js` | **New** - categories, recording, pending→approved/rejected workflow |
| Staff Performance | `performance.js` | **New** - evaluations, acknowledgement |
| ID Cards | `idcards.js` | **New** - PDF generation (individual + batch) via `pdfkit` |
| Transcripts | `transcripts.js` | **New** - JSON + PDF academic history, cumulative GPA |
| Communication | `communication.js` | Announcements (backed by the `notices` table), direct messages |
| Reports | `reports.js` | Single `/dashboard` endpoint feeding both the Dashboard and Reports tabs |
| Portal | `portal.js` | Parent-only: linked children, per-child attendance/results/invoices |

## Roles

`super_admin`, `school_admin`, `principal`, `teacher`, `accountant`,
`librarian`, `nurse`, `transport_officer`, `student`, `parent` - seeded in
`scripts/seed.js` along with every permission key each one needs. `principal`
and the `fees.approve` permission exist specifically to satisfy the fee
workflow's segregation-of-duties requirement. Similarly, `health.incidents.log`
is a narrower permission than `health.manage`: teachers hold it so they can log
something they witnessed without automatically gaining edit access to a
student's full medical record (blood group, allergies, vaccinations still
require `health.manage`, held by nurse/admin roles).

## What's genuinely still open

- **ID cards embed a real photo** when a document labeled like "Photo" (an
  image file) has been uploaded for that student via their profile - see
  `idcards.js`. If none has been uploaded yet, the card falls back to a
  labeled placeholder box rather than failing.
- **Uploaded files live on local disk** (`uploads/`, configurable via
  `UPLOADS_DIR`). This works cleanly on a VPS but is a real consideration on
  managed platforms with ephemeral filesystems (Railway/Render/Fly.io) -
  redeploys can wipe that directory unless you attach a persistent volume, or
  swap `src/utils/documents.js`'s storage for S3/R2-style object storage.
- Two of the three uploaded spec documents (the SRS blueprint and the
  architecture doc) describe more than either this schema or the frontend
  implement yet - a public admissions website, a student-facing portal, LMS,
  hostel/cafeteria modules, biometrics. None of that is started.

## Security

`.env.example` contains placeholder values only. Rotate the actual database
password, JWT secret, and bootstrap admin password before using this beyond
local development, and make sure `.env` stays out of version control (it's in
`.gitignore`).
