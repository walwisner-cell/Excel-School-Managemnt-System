// Generates the next permanent admission number for a school, atomically.
// Format: {year}-{5-digit sequence}, e.g. "2026-00007". Call this with the
// same `client` (not the pool) you're using for the rest of the enrollment/
// creation transaction, so a rollback anywhere in that transaction also
// rolls back the counter increment - no gaps from failed attempts.
async function nextAdmissionNo(client, schoolId) {
  const { rows } = await client.query(
    `INSERT INTO school_admission_counters (school_id, last_number) VALUES ($1, 1)
     ON CONFLICT (school_id) DO UPDATE SET last_number = school_admission_counters.last_number + 1
     RETURNING last_number`,
    [schoolId]
  );
  const year = new Date().getFullYear();
  return `${year}-${String(rows[0].last_number).padStart(5, '0')}`;
}

module.exports = { nextAdmissionNo };
