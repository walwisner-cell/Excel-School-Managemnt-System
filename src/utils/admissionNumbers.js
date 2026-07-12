// Generates the next permanent admission number for a school, atomically.
// Format: {school code}-{5-digit sequence}, e.g. "EXSS001-00007" - built from
// the school's own code (not the calendar year), so it stays meaningful and
// unchanged for a student's entire time at the school, from admission through
// graduation or departure, matching how a real admission number is meant to work.
async function nextAdmissionNo(client, schoolId) {
  const { rows: schoolRows } = await client.query('SELECT code FROM schools WHERE id = $1', [schoolId]);
  const schoolCode = schoolRows[0]?.code || 'SCH';
  const { rows } = await client.query(
    `INSERT INTO school_admission_counters (school_id, last_number) VALUES ($1, 1)
     ON CONFLICT (school_id) DO UPDATE SET last_number = school_admission_counters.last_number + 1
     RETURNING last_number`,
    [schoolId]
  );
  return `${schoolCode}-${String(rows[0].last_number).padStart(5, '0')}`;
}

module.exports = { nextAdmissionNo };
