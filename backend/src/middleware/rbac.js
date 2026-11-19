/**
 * RBAC Middleware
 *
 * requirePermission(resource, action)
 *   — checks role-based defaults + per-user overrides
 *   — admin always passes
 *   — handles permission inheritance:
 *       read:all      ⊇ read:team      ⊇ read:own
 *       update:all    ⊇ update:reports ⊇ update:own
 *       assign:all    ⊇ assign:reports ⊇ assign:own
 *
 * Scope: the role_permissions table only governs routes that use requirePermission
 * (departments, skills, agent-status, schedules). Tickets, KB, changes, problems,
 * dashboard, users and on-call use requireRole + config/constants.js — edit those there.
 *
 * canAccess(req, resource, action) → boolean (no HTTP response, for use inside controllers)
 */

const pool = require('../db/pool');

// ── Permission inheritance: if you have the "broader" permission,
//    you also have the "narrower" ones ─────────────────────────────────────────
const IMPLIES = {
  'read:all':         ['read:team',        'read:own'],
  'read:team':        ['read:own'],
  'update:all':       ['update:reports',   'update:own', 'update:assigned'],
  'update:reports':   ['update:own'],
  'assign:all':       ['assign:reports',   'assign:own'],
  'assign:reports':   ['assign:own'],
};

/**
 * Build the set of "equivalent" actions that would satisfy the requested one.
 * For example, requesting 'read:own' is also satisfied by 'read:team' or 'read:all'.
 */
function satisfiedBy(action) {
  const satisfiers = new Set([action]);
  for (const [broader, narrower] of Object.entries(IMPLIES)) {
    if (narrower.includes(action)) satisfiers.add(broader);
  }
  return [...satisfiers];
}

// ── In-memory permission cache (cleared on each process restart) ─────────────
// Key: `${role}` → Set<"resource:action">
const _roleCache = new Map();
const _roleCacheExpiry = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getRolePermissions(role) {
  const now = Date.now();
  if (_roleCache.has(role) && _roleCacheExpiry.get(role) > now) {
    return _roleCache.get(role);
  }
  const { rows } = await pool.query(`
    SELECT p.resource, p.action
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role = $1
  `, [role]);
  const perms = new Set(rows.map((r) => `${r.resource}:${r.action}`));
  _roleCache.set(role, perms);
  _roleCacheExpiry.set(role, now + CACHE_TTL_MS);
  return perms;
}

/**
 * Core check — returns true if the user has permission, false otherwise.
 * Used both by middleware and controllers.
 */
async function canAccess(req, resource, action) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;

  const { userId, role } = req.user;
  const satisfiers = satisfiedBy(action).map((a) => `${resource}:${a}`);

  // 1. Check explicit user overrides first
  const override = await pool.query(`
    SELECT up.granted
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id = $1
      AND p.resource = $2
      AND p.action   = ANY($3::text[])
      AND (up.expires_at IS NULL OR up.expires_at > NOW())
    ORDER BY up.granted DESC   -- explicit GRANT takes precedence over DENY
    LIMIT 1
  `, [userId, resource, satisfiers.map((s) => s.split(':').slice(1).join(':'))]);

  if (override.rows.length) {
    return override.rows[0].granted;
  }

  // 2. Check role-based permissions (with inheritance)
  const rolePerms = await getRolePermissions(role);
  return satisfiers.some((s) => rolePerms.has(s));
}

/**
 * Express middleware — 403 if permission not granted.
 */
function requirePermission(resource, action) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      const ok = await canAccess(req, resource, action);
      if (!ok) {
        return res.status(403).json({
          error: `Permission denied: requires ${resource}:${action}`,
          resource,
          action,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Check if the requesting user can manage the target user.
 * "Manage" = same user OR direct/indirect manager OR admin.
 */
async function canManageUser(requesterId, targetUserId, requesterRole) {
  if (requesterRole === 'admin') return true;
  if (requesterId === targetUserId) return true;

  // Walk up the reporting chain — is requester an ancestor of target?
  const { rows } = await pool.query(`
    WITH RECURSIVE hierarchy AS (
      SELECT id, manager_id, 0 AS depth FROM users WHERE id = $1
      UNION ALL
      SELECT u.id, u.manager_id, h.depth + 1
      FROM users u
      JOIN hierarchy h ON u.id = h.manager_id
      WHERE h.depth < 10   -- stops a manager_id cycle (A→B→A) from recursing forever
    )
    SELECT 1 FROM hierarchy WHERE id = $2 LIMIT 1
  `, [targetUserId, requesterId]);

  return rows.length > 0;
}

module.exports = {
  requirePermission,
  canAccess,
  canManageUser,
};
