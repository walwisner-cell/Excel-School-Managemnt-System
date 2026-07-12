const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('./asyncHandler');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('./audit');

/**
 * Builds a full CRUD router (list/get/create/update/delete) for a table that has a
 * `school_id`, `created_by`/`updated_by`, and `created_at`/`updated_at` column.
 *
 * Response shapes are RAW, not wrapped in {data: ...}:
 *   GET  /          -> [ {...}, {...} ]                (plain array)
 *   GET  /:id        -> {...}                            (plain object)
 *   POST /          -> {...}                             (the created row)
 *   PUT  /:id        -> {...}                             (the updated row)
 *   DELETE /:id       -> 204 No Content
 * This matches public/index.html's api() helper, which returns res.json()
 * directly with no envelope unwrapping (aside from the generic MODULES
 * table renderer, which defensively accepts either shape).
 *
 * options:
 *   table             - table name (also used as the audit log's tableName)
 *   fields            - column names the client may set on create/update
 *   requiredOnCreate  - subset of `fields` that must be present on POST
 *   viewPermission    - permission key allowed to GET
 *   managePermission  - permission key allowed to POST/PUT/DELETE
 *   searchFields      - text columns matched against ?q= (ILIKE)
 *   orderBy           - ORDER BY clause (default 'id')
 *   extraSelect       - extra SQL for the SELECT list (e.g. joined display columns)
 *   extraJoin         - extra JOIN clause to support extraSelect
 *   filterFields      - column names allowed as exact-match query filters (e.g. ?route_id=5)
 */
function buildCrudRouter({
  table,
  fields,
  requiredOnCreate = [],
  viewPermission,
  managePermission,
  searchFields = [],
  orderBy = 'id',
  extraSelect = '',
  extraJoin = '',
  filterFields = [],
}) {
  const router = express.Router();
  router.use(authenticate);
  const selectList = extraSelect ? `t.*, ${extraSelect}` : 't.*';

  function requireSchoolId(req, res) {
    const schoolId = resolveSchoolId(req);
    if (!schoolId) {
      res.status(400).json({ error: 'school_id is required (super_admin must pass ?school_id=)' });
      return null;
    }
    return schoolId;
  }

  // LIST
  router.get('/', authorize(viewPermission, managePermission), asyncHandler(async (req, res) => {
    const schoolId = requireSchoolId(req, res);
    if (!schoolId) return;
    const params = [schoolId];
    let where = 't.school_id = $1';
    if (req.query.q && searchFields.length) {
      params.push(`%${req.query.q}%`);
      where += ` AND (${searchFields.map((f) => `t.${f} ILIKE $${params.length}`).join(' OR ')})`;
    }
    for (const field of filterFields) {
      if (req.query[field] !== undefined) {
        params.push(req.query[field]);
        where += ` AND t.${field} = $${params.length}`;
      }
    }
    const { rows } = await pool.query(
      `SELECT ${selectList} FROM ${table} t ${extraJoin} WHERE ${where} ORDER BY ${orderBy}`,
      params
    );
    res.json(rows);
  }));

  // GET ONE
  router.get('/:id', authorize(viewPermission, managePermission), asyncHandler(async (req, res) => {
    const schoolId = requireSchoolId(req, res);
    if (!schoolId) return;
    const { rows } = await pool.query(
      `SELECT ${selectList} FROM ${table} t ${extraJoin} WHERE t.id = $1 AND t.school_id = $2`,
      [req.params.id, schoolId]
    );
    if (!rows[0]) return res.status(404).json({ error: `${table} record ${req.params.id} not found` });
    res.json(rows[0]);
  }));

  // CREATE
  router.post('/', authorize(managePermission), asyncHandler(async (req, res) => {
    const schoolId = requireSchoolId(req, res);
    if (!schoolId) return;
    const missing = requiredOnCreate.filter((f) => req.body[f] === undefined || req.body[f] === null || req.body[f] === '');
    if (missing.length) return res.status(400).json({ error: `Missing required field(s): ${missing.join(', ')}` });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Only include fields the client actually sent - omitted fields are left out of
      // the INSERT entirely (rather than explicitly set to NULL) so the column's own
      // DEFAULT in schema.sql (e.g. status = 'active', audience = 'all') applies.
      const providedFields = fields.filter((f) => f in req.body);
      const cols = ['school_id', ...providedFields, 'created_by', 'updated_by'];
      const values = [schoolId, ...providedFields.map((f) => req.body[f]), req.user.id, req.user.id];
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await client.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      await logAudit(client, {
        schoolId, tableName: table, recordId: rows[0].id, action: 'create',
        changedBy: req.user.id, oldValues: null, newValues: rows[0],
      });
      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'A record with that value already exists' });
      if (err.code === '23514') return res.status(400).json({ error: 'One of the values provided isn\'t valid (e.g. an amount must be greater than zero)' });
      throw err;
    } finally {
      client.release();
    }
  }));

  // UPDATE
  router.put('/:id', authorize(managePermission), asyncHandler(async (req, res) => {
    const schoolId = requireSchoolId(req, res);
    if (!schoolId) return;
    const setCols = fields.filter((f) => f in req.body);
    if (!setCols.length) return res.status(400).json({ error: 'No updatable fields provided' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: existingRows } = await client.query(
        `SELECT * FROM ${table} WHERE id = $1 AND school_id = $2 FOR UPDATE`,
        [req.params.id, schoolId]
      );
      if (!existingRows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${table} record ${req.params.id} not found` });
      }
      const setClause = setCols.map((f, i) => `${f} = $${i + 1}`).join(', ');
      const values = setCols.map((f) => req.body[f]);
      const userIdIdx = values.length + 1;
      const idIdx = values.length + 2;
      const schoolIdIdx = values.length + 3;
      values.push(req.user.id, req.params.id, schoolId);
      const { rows } = await client.query(
        `UPDATE ${table} SET ${setClause}, updated_by = $${userIdIdx}, updated_at = now()
         WHERE id = $${idIdx} AND school_id = $${schoolIdIdx} RETURNING *`,
        values
      );
      await logAudit(client, {
        schoolId, tableName: table, recordId: rows[0].id, action: 'update',
        changedBy: req.user.id, oldValues: existingRows[0], newValues: rows[0],
      });
      await client.query('COMMIT');
      res.json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'A record with that value already exists' });
      if (err.code === '23514') return res.status(400).json({ error: 'One of the values provided isn\'t valid (e.g. an amount must be greater than zero)' });
      throw err;
    } finally {
      client.release();
    }
  }));

  // DELETE
  router.delete('/:id', authorize(managePermission), asyncHandler(async (req, res) => {
    const schoolId = requireSchoolId(req, res);
    if (!schoolId) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: existingRows } = await client.query(
        `SELECT * FROM ${table} WHERE id = $1 AND school_id = $2`,
        [req.params.id, schoolId]
      );
      if (!existingRows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `${table} record ${req.params.id} not found` });
      }
      await client.query(`DELETE FROM ${table} WHERE id = $1 AND school_id = $2`, [req.params.id, schoolId]);
      await logAudit(client, {
        schoolId, tableName: table, recordId: req.params.id, action: 'delete',
        changedBy: req.user.id, oldValues: existingRows[0], newValues: null,
      });
      await client.query('COMMIT');
      res.status(204).send();
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23503') return res.status(409).json({ error: 'This record is still referenced elsewhere in the system and can\'t be deleted' });
      throw err;
    } finally {
      client.release();
    }
  }));

  return router;
}

module.exports = { buildCrudRouter };
