const jwt = require('jsonwebtoken');
const pool = require('../../config/db');
const { getEffectivePermissions } = require('../utils/permissions');

/**
 * Verifies the Bearer token, then re-derives the user's CURRENT effective
 * permissions from the database (role defaults, with any per-user overrides
 * applied) rather than trusting whatever was embedded in the token at login.
 * This is what makes per-user permission changes (Users & Access -> Manage
 * Permissions) take effect immediately, on the very next request - not just
 * after the affected user logs out and back in. The extra query is one indexed
 * join, which is a fine trade-off at this system's scale for that guarantee.
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows: userRows } = await pool.query(
      `SELECT u.id, u.school_id, u.status, u.role_id, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [payload.sub]
    );
    const user = userRows[0];
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Account no longer active' });
    }

    const permissions = await getEffectivePermissions(pool, user.id, user.role_id);
    req.user = {
      id: user.id,
      schoolId: user.school_id ?? null,
      roleId: user.role_id,
      roleName: user.role_name,
      permissions,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Returns middleware requiring the authenticated user to hold at least one of the
 * given permission keys. super_admin always passes. Call with no arguments to just
 * require "any authenticated user" (rarely needed - authenticate() already does that).
 */
function authorize(...permissionKeys) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.roleName === 'super_admin') return next();
    if (permissionKeys.length === 0) return next();
    const allowed = permissionKeys.filter(Boolean);
    const has = allowed.some((key) => req.user.permissions.includes(key));
    if (!has) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

/**
 * Resolves which school_id a request should operate against.
 * - super_admin has no home school and may target any tenant via ?school_id=
 * - every other role is hard-locked to their own school_id, regardless of query params,
 *   so a compromised/misbehaving client can never read or write another tenant's data.
 */
function resolveSchoolId(req) {
  if (req.user.roleName === 'super_admin') {
    if (!req.query.school_id) return null; // caller must handle "no tenant selected"
    return Number(req.query.school_id);
  }
  return req.user.schoolId;
}

module.exports = { authenticate, authorize, resolveSchoolId };
