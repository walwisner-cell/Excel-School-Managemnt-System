// Generates the next number in a named, per-school, gap-free sequence.
// Mirrors admissionNumbers.js's contract: pass the same `client` you're using
// for the surrounding transaction so a rollback also rolls back the counter.
async function nextNumber(client, schoolId, series, { prefix, digits = 5 } = {}) {
  const { rows } = await client.query(
    `INSERT INTO school_number_counters (school_id, series, last_number) VALUES ($1, $2, 1)
     ON CONFLICT (school_id, series) DO UPDATE SET last_number = school_number_counters.last_number + 1
     RETURNING last_number`,
    [schoolId, series]
  );
  const year = new Date().getFullYear();
  const padded = String(rows[0].last_number).padStart(digits, '0');
  return prefix ? `${prefix}-${year}-${padded}` : `${year}-${padded}`;
}

module.exports = { nextNumber };
