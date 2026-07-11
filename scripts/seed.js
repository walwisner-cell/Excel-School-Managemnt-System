require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

const PERMISSIONS = [
  ['students.view', 'View student records'],
  ['students.create', 'Create students'],
  ['students.update', 'Update students'],
  ['students.delete', 'Delete/withdraw students'],
  ['guardians.manage', 'Manage guardians'],
  ['staff.view', 'View staff records'],
  ['staff.create', 'Create staff'],
  ['staff.update', 'Update staff'],
  ['staff.delete', 'Delete staff'],
  ['admissions.manage', 'Manage admission inquiries/applications'],
  ['academics.manage', 'Manage classes, sections, subjects, timetable'],
  ['attendance.mark', 'Mark attendance'],
  ['attendance.view', 'View attendance records'],
  ['exams.manage', 'Manage exams and grading scales'],
  ['marks.enter', 'Enter/edit marks'],
  ['marks.view', 'View marks/report cards'],
  ['fees.manage', 'Manage fee structures and invoices'],
  ['fees.collect', 'Record payments'],
  ['fees.view', 'View fee/payment records'],
  ['communication.manage', 'Post notices and send messages'],
  ['reports.view', 'View reporting dashboards'],
  ['users.manage', 'Manage users and role assignments'],
  ['schools.manage', 'Manage tenant schools (super admin only)'],
  ['school_settings.manage', 'Edit own school\'s basic info and currency settings'],
  ['library.view', 'View library catalog and loans'],
  ['library.manage', 'Manage library catalog and issue/return books'],
  ['transport.view', 'View transport routes and assignments'],
  ['transport.manage', 'Manage vehicles, routes, and student assignments'],
  ['health.view', 'View student health records'],
  ['health.manage', 'Edit full health records (blood group, allergies, vaccinations, etc.)'],
  ['health.incidents.log', 'Log a health incident, without full health-record edit access'],
  ['inventory.view', 'View inventory items and stock levels'],
  ['inventory.manage', 'Manage inventory items and stock transactions'],
  ['events.view', 'View school events'],
  ['events.manage', 'Create and publish school events'],
  ['fees.approve', 'Final sign-off on fee payments (Principal-level; deliberately excluded from school_admin - see ROLE_PERMISSIONS below)'],
  ['expenses.view', 'View recorded expenses'],
  ['expenses.manage', 'Record expenses and categories'],
  ['expenses.approve', 'Approve or reject recorded expenses'],
  ['performance.view', 'View staff performance evaluations'],
  ['performance.manage', 'Create staff performance evaluations'],
  ['idcards.generate', 'Generate student/staff ID card PDFs'],
  ['transcripts.view', 'View and export student transcripts'],
  ['portal.view', 'Access the parent portal (view own children only)'],
  ['leave.manage', 'Submit, view, and approve leave requests for students and staff'],
  ['timetable.manage', 'Manage teacher-subject-class assignments and the weekly timetable'],
  ['gallery.manage', 'Upload and manage photos on the public website gallery'],
  ['site_content.manage', 'Edit the public website\'s text content (headline, mission statement, page intros)'],
];

// fees.approve is deliberately withheld from school_admin (unlike every other
// permission, which school_admin gets automatically below): the fee-payment
// workflow's segregation of duties requires that the person who can do
// day-to-day administration is NOT automatically the same person who gives
// final sign-off on money received. Only `principal` and `super_admin` hold it.
const SCHOOL_ADMIN_EXCLUDED = ['schools.manage', 'fees.approve'];

const ROLE_PERMISSIONS = {
  super_admin: PERMISSIONS.map((p) => p[0]), // everything
  school_admin: PERMISSIONS.map((p) => p[0]).filter((k) => !SCHOOL_ADMIN_EXCLUDED.includes(k)),
  principal: [
    'students.view', 'staff.view', 'admissions.manage', 'academics.manage',
    'exams.manage', 'marks.view', 'fees.view', 'fees.approve',
    'expenses.view', 'expenses.approve', 'performance.view', 'performance.manage',
    'communication.manage', 'events.view', 'events.manage', 'reports.view',
    'idcards.generate', 'transcripts.view', 'school_settings.manage',
    'leave.manage', 'timetable.manage', 'gallery.manage', 'site_content.manage',
  ],
  teacher: [
    'students.view', 'attendance.mark', 'attendance.view',
    'marks.enter', 'marks.view', 'communication.manage', 'reports.view',
    'library.view', 'events.view', 'transcripts.view', 'idcards.generate',
    'health.view', 'health.incidents.log', // can look up a student's page and log an incident,
                                            // but PUT (editing blood group, allergies, etc.) still requires health.manage
    'leave.manage', // can submit/view leave requests (their own or on a student's behalf)
  ],
  accountant: [
    'students.view', 'fees.manage', 'fees.collect', 'fees.view', 'reports.view',
    'inventory.view', 'events.view', 'expenses.manage', 'expenses.view',
  ],
  librarian: ['students.view', 'staff.view', 'library.view', 'library.manage'],
  nurse: ['students.view', 'health.view', 'health.manage', 'events.view'],
  transport_officer: ['students.view', 'staff.view', 'transport.view', 'transport.manage', 'events.view'],
  student: ['attendance.view', 'marks.view', 'fees.view', 'library.view', 'transport.view', 'health.view', 'events.view'],
  parent: ['attendance.view', 'marks.view', 'fees.view', 'library.view', 'transport.view', 'health.view', 'events.view', 'portal.view'],
};

const ATTENDANCE_STATUSES = [
  ['present', 'Present', true],
  ['absent', 'Absent', false],
  ['late', 'Late', true],
  ['half_day', 'Half Day', false],
  ['excused', 'Excused Absence', false],
  ['sick', 'Sick', false],
  ['on_leave', 'On Approved Leave', false],
];

// Liberia's 6-3-3 structure: two years of pre-primary, then Primary (Grades 1-6),
// Junior High (7-9), Senior High (10-12). Names/sections/teachers are all editable
// afterward from the Classes & Sections screen - this just gets a new school started
// with the right shape instead of an empty list.
const LIBERIA_CLASSES = [
  'Nursery', 'K1', 'K2',
  'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
  'Grade 7', 'Grade 8', 'Grade 9',
  'Grade 10', 'Grade 11', 'Grade 12',
];

// Core subjects common across Liberian primary/JHS/SHS curricula. Not every subject
// applies to every grade (e.g. Physics/Chemistry/Biology are SHS-level) - assign
// per-class via Timetables/Teacher assignment as needed; this just seeds the list.
const LIBERIA_SUBJECTS = [
  ['English Language', 'ENG'], ['Mathematics', 'MATH'], ['French', 'FRE'],
  ['General Science', 'GSCI'], ['Social Studies', 'SOST'], ['Physical Education', 'PE'],
  ['Religious and Moral Education', 'RME'], ['Civics', 'CIV'],
  ['Literature', 'LIT'], ['History', 'HIST'], ['Geography', 'GEOG'], ['Economics', 'ECON'],
  ['Physics', 'PHY'], ['Chemistry', 'CHEM'], ['Biology', 'BIO'],
];

// Starting-point grading scale. Liberian schools vary in their exact percentage
// cutoffs, so treat this as an editable default (Exams -> Grading Scales) rather
// than an official standard - adjust it to match your school's actual report cards.
const LIBERIA_GRADE_BANDS = [
  [90, 100, 'A', 4.0],
  [80, 89.99, 'B', 3.0],
  [70, 79.99, 'C', 2.0],
  [60, 69.99, 'D', 1.0],
  [0, 59.99, 'F', 0.0],
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Roles
    for (const name of Object.keys(ROLE_PERMISSIONS)) {
      await client.query(
        `INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [name]
      );
    }

    // Permissions
    for (const [key, description] of PERMISSIONS) {
      await client.query(
        `INSERT INTO permissions (key, description) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, description]
      );
    }

    // Role <-> Permission mapping
    for (const [roleName, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
      const { rows: roleRows } = await client.query('SELECT id FROM roles WHERE name = $1', [roleName]);
      const roleId = roleRows[0].id;
      for (const key of permKeys) {
        const { rows: permRows } = await client.query('SELECT id FROM permissions WHERE key = $1', [key]);
        if (!permRows[0]) continue;
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [roleId, permRows[0].id]
        );
      }
    }

    // Default demo school (skip if any school already exists)
    const { rows: existingSchools } = await client.query('SELECT id FROM schools LIMIT 1');
    let schoolId;
    if (existingSchools.length === 0) {
      const { rows } = await client.query(
        // 190 LRD/USD is illustrative only - update this to the real current rate
        // from Settings once the school is live; exchange rates move often.
        `INSERT INTO schools (name, code, primary_currency, exchange_rate_lrd_per_usd) VALUES ($1, $2, $3, $4) RETURNING id`,
        ['Demo School', 'DEMO01', 'USD', 190.00]
      );
      schoolId = rows[0].id;
      console.log(`Created demo school (id=${schoolId}, code=DEMO01)`);

      // Academic year: Liberia's school year officially runs September-June.
      const now = new Date();
      const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1; // month 8 = September (0-indexed)
      const { rows: yearRows } = await client.query(
        `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [schoolId, `${startYear}-${startYear + 1}`, `${startYear}-09-01`, `${startYear + 1}-06-30`]
      );
      const academicYearId = yearRows[0].id;
      console.log(`Created academic year ${startYear}-${startYear + 1} (Sept-June)`);

      // Three terms, editable afterward (Settings -> Academics -> Terms).
      const termDates = [
        ['Term 1', `${startYear}-09-01`, `${startYear}-12-19`],
        ['Term 2', `${startYear + 1}-01-06`, `${startYear + 1}-03-27`],
        ['Term 3', `${startYear + 1}-04-06`, `${startYear + 1}-06-30`],
      ];
      for (let i = 0; i < termDates.length; i++) {
        const [name, start, end] = termDates[i];
        await client.query(
          `INSERT INTO terms (school_id, academic_year_id, name, start_date, end_date, is_current, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [schoolId, academicYearId, name, start, end, i === 0, i]
        );
      }
      console.log('Created 3 terms (Term 1, Term 2, Term 3)');

      // Classes: Nursery/K1/K2 + Grades 1-12, per Liberia's 6-3-3 structure.
      for (let i = 0; i < LIBERIA_CLASSES.length; i++) {
        await client.query(
          `INSERT INTO classes (school_id, academic_year_id, name, sort_order) VALUES ($1, $2, $3, $4)`,
          [schoolId, academicYearId, LIBERIA_CLASSES[i], i]
        );
      }
      console.log(`Created ${LIBERIA_CLASSES.length} classes (Nursery through Grade 12)`);

      // Subjects
      for (const [name, code] of LIBERIA_SUBJECTS) {
        await client.query(
          `INSERT INTO subjects (school_id, name, code) VALUES ($1, $2, $3) ON CONFLICT (school_id, code) DO NOTHING`,
          [schoolId, name, code]
        );
      }
      console.log(`Created ${LIBERIA_SUBJECTS.length} subjects`);

      // Default grading scale - see LIBERIA_GRADE_BANDS comment: adjust to your
      // school's real cutoffs from Exams -> Grading Scales.
      const { rows: scaleRows } = await client.query(
        `INSERT INTO grading_scales (school_id, name, effective_from, is_active) VALUES ($1, $2, $3, true) RETURNING id`,
        [schoolId, 'Standard Scale', `${startYear}-09-01`]
      );
      for (const [min, max, letter, points] of LIBERIA_GRADE_BANDS) {
        await client.query(
          `INSERT INTO grade_bands (grading_scale_id, min_percent, max_percent, letter_grade, grade_point) VALUES ($1, $2, $3, $4, $5)`,
          [scaleRows[0].id, min, max, letter, points]
        );
      }
      console.log('Created default grading scale (A-F) - review and adjust to your school\'s actual cutoffs');
    } else {
      schoolId = existingSchools[0].id;
    }

    // Attendance statuses for the demo school
    for (const [code, label, countsPresent] of ATTENDANCE_STATUSES) {
      await client.query(
        `INSERT INTO attendance_statuses (school_id, code, label, counts_present)
         VALUES ($1, $2, $3, $4) ON CONFLICT (school_id, code) DO NOTHING`,
        [schoolId, code, label, countsPresent]
      );
    }

    // Bootstrap super admin (school_id NULL -> global)
    const { rows: existingAdmins } = await client.query(
      `SELECT id FROM users WHERE school_id IS NULL LIMIT 1`
    );
    if (existingAdmins.length === 0) {
      const { rows: roleRows } = await client.query(`SELECT id FROM roles WHERE name = 'super_admin'`);
      const passwordHash = await bcrypt.hash(
        process.env.BOOTSTRAP_ADMIN_PASSWORD || 'ChangeMe123!',
        10
      );
      await client.query(
        `INSERT INTO users (school_id, role_id, username, email, password_hash)
         VALUES (NULL, $1, $2, $3, $4)`,
        [roleRows[0].id, 'superadmin', process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com', passwordHash]
      );
      console.log(`Created super admin: ${process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com'}`);
    }

    await client.query('COMMIT');
    console.log('Seed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
