const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { JWT_SECRET, JWT_EXPIRES_IN, COOKIE_NAME } = require('../middleware/auth');

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 24 * 60 * 60 * 1000, // 24 h
  path: '/',
};

// ─── Brute-force guard: 10 failed logins per IP per 15 minutes ───────────────
// shortcut: in-memory and per process; move to Redis/DB once more than one API process runs.
const FAIL_LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // ip → { count, resetAt }

function isBlocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() > f.resetAt) {
    failures.delete(ip);
    return false;
  }
  return f.count >= FAIL_LIMIT;
}

function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || now > f.resetAt) failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else f.count++;
  // Keep memory bounded under a spray from many IPs
  if (failures.size > 10000) {
    for (const [k, v] of failures) if (now > v.resetAt) failures.delete(k);
  }
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

const login = async (req, res, next) => {
  try {
    if (isBlocked(req.ip)) {
      return res.status(429).json({ error: 'Too many failed logins — try again in 15 minutes' });
    }
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const {
      rows: [user],
    } = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [
      email.trim().toLowerCase(),
    ]);

    const valid = user && (await bcrypt.compare(password, user.password_hash));
    if (!valid) {
      recordFailure(req.ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    failures.delete(req.ip);

    const payload = {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      department: user.department,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    res.json({ user: payload });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

const logout = (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ message: 'Logged out successfully' });
};

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────

const me = (req, res) => {
  // req.user is set by requireAuth middleware
  res.json({ user: req.user });
};

module.exports = { login, logout, me };
