const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

router.use('/vehicles', buildCrudRouter({
  table: 'transport_vehicles',
  fields: ['vehicle_no', 'vehicle_type', 'capacity', 'driver_name', 'driver_phone', 'status'],
  requiredOnCreate: ['vehicle_no'],
  viewPermission: 'transport.view',
  managePermission: 'transport.manage',
  searchFields: ['vehicle_no', 'driver_name'],
  orderBy: 'vehicle_no',
}));

// Registered before the generic CRUD mount below: student_transport references
// routes with ON DELETE CASCADE, which would silently un-assign every student
// currently riding this route with no visible trace in the Transport screen.
router.delete('/routes/:id', authorize('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows: activeRiders } = await pool.query(`SELECT id FROM student_transport WHERE route_id = $1 AND status = 'active' LIMIT 1`, [req.params.id]);
  if (activeRiders[0]) {
    return res.status(409).json({ error: 'Students are actively assigned to this route - move them to another route first' });
  }
  const { rows } = await pool.query('DELETE FROM transport_routes WHERE id = $1 AND school_id = $2 RETURNING *', [req.params.id, schoolId]);
  if (!rows[0]) return res.status(404).json({ error: 'Route not found' });
  await logAudit(pool, { schoolId, tableName: 'transport_routes', recordId: rows[0].id, action: 'delete', changedBy: req.user.id, oldValues: rows[0], newValues: null }).catch(() => {});
  res.status(204).send();
}));

// Routes need the assigned vehicle's number for display, so this uses the join hooks.
router.use('/routes', buildCrudRouter({
  table: 'transport_routes',
  fields: ['name', 'description', 'vehicle_id', 'fare_amount', 'status'],
  requiredOnCreate: ['name'],
  viewPermission: 'transport.view',
  managePermission: 'transport.manage',
  searchFields: ['name'],
  orderBy: 'name',
  extraSelect: 'v.vehicle_no',
  extraJoin: 'LEFT JOIN transport_vehicles v ON v.id = t.vehicle_id',
}));

router.use('/stops', buildCrudRouter({
  table: 'transport_stops',
  fields: ['route_id', 'name', 'sequence_no', 'pickup_time', 'drop_time'],
  requiredOnCreate: ['route_id', 'name'],
  viewPermission: 'transport.view',
  managePermission: 'transport.manage',
  searchFields: ['name'],
  filterFields: ['route_id'],
  orderBy: 'sequence_no',
}));

router.get('/assignments', authorize('transport.view', 'transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const params = [schoolId];
  let where = "st.school_id = $1 AND st.status = 'active'";
  if (req.query.route_id) { params.push(req.query.route_id); where += ` AND st.route_id = $${params.length}`; }
  if (req.query.student_id) { params.push(req.query.student_id); where += ` AND st.student_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT st.*, s.first_name, s.last_name, tr.name AS route_name, ts.name AS stop_name
     FROM student_transport st
     JOIN students s ON s.id = st.student_id
     JOIN transport_routes tr ON tr.id = st.route_id
     LEFT JOIN transport_stops ts ON ts.id = st.stop_id
     WHERE ${where} ORDER BY s.last_name, s.first_name`,
    params
  );
  res.json(rows);
}));

// { student_id, route_id, stop_id? }
router.post('/assignments', authorize('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { student_id, route_id, stop_id } = req.body;
  if (!student_id || !route_id) return res.status(400).json({ error: 'student_id and route_id are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE student_transport SET status = 'ended', end_date = CURRENT_DATE, updated_at = now(), updated_by = $1
       WHERE student_id = $2 AND school_id = $3 AND status = 'active'`,
      [req.user.id, student_id, schoolId]
    );
    const { rows } = await client.query(
      `INSERT INTO student_transport (school_id, student_id, route_id, stop_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [schoolId, student_id, route_id, stop_id || null, req.user.id]
    );
    await logAudit(client, { schoolId, tableName: 'student_transport', recordId: rows[0].id, action: 'create', changedBy: req.user.id, oldValues: null, newValues: rows[0] });
    await client.query('COMMIT');

    // Capacity is often approximate in practice (an extra child on a bus isn't
    // unusual), so this is a warning surfaced to the caller, not a hard block.
    const { rows: capacityCheck } = await pool.query(
      `SELECT v.capacity, v.vehicle_no, COUNT(st.id) AS rider_count
       FROM transport_routes r
       JOIN transport_vehicles v ON v.id = r.vehicle_id
       LEFT JOIN student_transport st ON st.route_id = r.id AND st.status = 'active'
       WHERE r.id = $1 GROUP BY v.capacity, v.vehicle_no`,
      [route_id]
    );
    let capacityWarning = null;
    if (capacityCheck[0]?.capacity && Number(capacityCheck[0].rider_count) > Number(capacityCheck[0].capacity)) {
      capacityWarning = `Heads up: ${capacityCheck[0].vehicle_no} now has ${capacityCheck[0].rider_count} riders assigned, over its stated capacity of ${capacityCheck[0].capacity}.`;
    }
    res.status(201).json({ ...rows[0], capacityWarning });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.put('/assignments/:id/end', authorize('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `UPDATE student_transport SET status = 'ended', end_date = CURRENT_DATE, updated_at = now(), updated_by = $1
     WHERE id = $2 AND school_id = $3 RETURNING *`,
    [req.user.id, req.params.id, schoolId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Assignment not found' });
  res.json(rows[0]);
}));

module.exports = router;
