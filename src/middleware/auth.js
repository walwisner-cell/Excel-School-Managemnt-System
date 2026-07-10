const jwt = require('jsonwebtoken');

/**
 * Verifies the Bearer token and attaches req.user.
 *
 * Permission keys are embedded in the JWT at login time (see routes/auth.js) rather
 * than re-queried on every request. Trade-off: a permission change takes effect on
 * the user's next login/token refresh, not instantly - acceptable for this system's
 * size, and avoids a join on role_permissions for every single API call.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.sub,
      schoolId: payload.schoolId ?? null,
      roleId: payload.roleId,
      roleName: payload.roleName,
      permissions: payload.permissions || [],
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
