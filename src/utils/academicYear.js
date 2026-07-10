// Resolves the school's current academic year (is_current = true), falling back to
// the most recent one on file, and creating a sensible default (Jan 1 - Dec 31 of
// the current calendar year) only if the school has none at all yet.
async function getOrCreateCurrentAcademicYear(client, schoolId) {
  const { rows } = await client.query(
    'SELECT * FROM academic_years WHERE school_id = $1 AND is_current = true LIMIT 1',
    [schoolId]
  );
  if (rows[0]) return rows[0];
  const { rows: anyYear } = await client.query(
    'SELECT * FROM academic_years WHERE school_id = $1 ORDER BY start_date DESC LIMIT 1',
    [schoolId]
  );
  if (anyYear[0]) return anyYear[0];
  const year = new Date().getFullYear();
  const { rows: created } = await client.query(
    `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current) VALUES ($1, $2, $3, $4, true) RETURNING *`,
    [schoolId, `${year}-${year + 1}`, `${year}-01-01`, `${year}-12-31`]
  );
  return created[0];
}

module.exports = { getOrCreateCurrentAcademicYear };
