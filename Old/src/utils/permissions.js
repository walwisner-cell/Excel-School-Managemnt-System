// Computes a user's CURRENT effective permission set: their role's default
// permissions, with any per-user overrides applied on top (a granted=true override
// adds a permission the role doesn't include; granted=false revokes one the role
// does include). Shared by both login (src/routes/auth.js, for the initial response
// body) and the per-request auth middleware (src/middleware/auth.js) so there is
// exactly one implementation of this logic - two separate copies is how the login
// response and the actual enforced permissions would quietly drift apart.
async function getEffectivePermissions(pool, userId, roleId) {
  const { rows } = await pool.query(
    `SELECT p.key
     FROM permissions p
     LEFT JOIN role_permissions rp ON rp.permission_id = p.id AND rp.role_id = $1
     LEFT JOIN user_permission_overrides upo ON upo.permission_id = p.id AND upo.user_id = $2
     WHERE COALESCE(upo.granted, rp.role_id IS NOT NULL)`,
    [roleId, userId]
  );
  return rows.map((r) => r.key);
}

module.exports = { getEffectivePermissions };
