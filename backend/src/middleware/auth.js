const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const COOKIE_NAME = 'dispatchly_token';

// A missing or placeholder secret lets anyone forge an admin token, so refuse to start.
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.startsWith('changeme')) {
  throw new Error(
    'JWT_SECRET must be a random string of at least 32 characters (e.g. `openssl rand -hex 32`)'
  );
}

/**
 * Require a valid JWT cookie. Attaches req.user = { userId, email, name, role, department }.
 * Role and active flag come from the DB on every request, so deactivation/demotion apply at once.
 */
const requireAuth = async (req, res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }

  try {
    const {
      rows: [user],
    } = await pool.query('SELECT name, role, department, is_active FROM users WHERE id = $1', [
      payload.userId,
    ]);
    if (!user?.is_active) {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      return res.status(401).json({ error: 'Account is disabled — please contact an admin' });
    }
    req.user = { ...payload, name: user.name, role: user.role, department: user.department };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Require one of the given roles (admin always passes).
 * Must be used after requireAuth.
 *
 * Usage: requireRole('admin', 'manager')
 */
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'admin') return next(); // admin bypasses all role checks
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }
    next();
  };

module.exports = { requireAuth, requireRole, JWT_SECRET, JWT_EXPIRES_IN, COOKIE_NAME };
