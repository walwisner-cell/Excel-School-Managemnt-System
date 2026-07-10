/**
 * Writes an audit log row. Pass the same `client` used for the surrounding
 * transaction so the log commits/rolls back atomically with the change.
 */
async function logAudit(client, { schoolId, tableName, recordId, action, changedBy, oldValues, newValues }) {
  await client.query(
    `INSERT INTO audit_logs (school_id, table_name, record_id, action, changed_by, old_values, new_values)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      schoolId || null,
      tableName,
      recordId || null,
      action,
      changedBy || null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
}

module.exports = { logAudit };
