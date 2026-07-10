const express = require('express');
const pool = require('../../config/db');
const asyncHandler = require('../utils/asyncHandler');
const { buildCrudRouter } = require('../utils/crudRouter');
const { authenticate, authorize, resolveSchoolId } = require('../middleware/auth');

const router = express.Router();

router.use('/', buildCrudRouter({
  table: 'events',
  fields: ['title', 'description', 'event_type', 'event_date', 'start_datetime', 'end_datetime', 'location', 'audience', 'class_id', 'status', 'is_published'],
  requiredOnCreate: ['title'],
  viewPermission: 'events.view',
  managePermission: 'events.manage',
  searchFields: ['title', 'description', 'location'],
  orderBy: 'event_date NULLS LAST, id',
}));

router.use(authenticate);

router.get('/upcoming', authorize('events.view', 'events.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const { rows } = await pool.query(
    `SELECT * FROM events WHERE school_id = $1 AND status != 'cancelled' AND event_date >= CURRENT_DATE
     ORDER BY event_date LIMIT 50`,
    [schoolId]
  );
  res.json(rows);
}));

router.post('/:id/rsvp', authorize('events.view', 'events.manage'), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'school_id is required' });
  const status = req.body.status || 'going';
  if (!['going', 'not_going', 'maybe'].includes(status)) {
    return res.status(400).json({ error: "status must be 'going', 'not_going', or 'maybe'" });
  }
  const { rows } = await pool.query(
    `INSERT INTO event_rsvps (school_id, event_id, user_id, status) VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id, user_id) DO UPDATE SET status = $4 RETURNING *`,
    [schoolId, req.params.id, req.user.id, status]
  );
  res.status(201).json(rows[0]);
}));

module.exports = router;
