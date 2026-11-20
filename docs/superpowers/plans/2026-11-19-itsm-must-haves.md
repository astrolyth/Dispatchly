# Dispatchly ITSM Must-Haves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six gaps that keep Dispatchly from production use: audit trail, waiting states with SLA pause, attachments, two-way email, search/views/bulk actions, and identity (password reset, MFA, SSO).

**Architecture:** Keep the existing shape — Express 5 controllers + raw `pg` + numbered migrations + React Router loaders. Two shared seams are introduced first and reused by every later phase: one ticket-update service (`services/ticketUpdates.js`) that every status/field change goes through, and one audit writer (`services/audit.js`). Everything else is additive.

**Tech Stack:** Node ≥26, Express 5, PostgreSQL 18, `pg`, `node:test`, React 19, React Router 7, Tailwind 4.

**Spec:** The "Must-haves" section of the gap analysis given in chat on 2026-11-19 (attachments; SSO/MFA/password reset; audit trail + field history; Pending/On Hold with SLA pause, reopen, auto-close; two-way email + watchers; full-text search, saved views, bulk actions). Design decisions made for this plan are listed under **Decisions** — review those first.

## Decisions (defaults chosen for this plan — change before executing if wrong)

| # | Decision | Why |
|---|---|---|
| D1 | Attachments on local disk (`UPLOAD_DIR`, default `backend/uploads/`), random stored names | Single-server deploy today. `shortcut:` comment names S3 as the upgrade when >1 API instance |
| D2 | SSO via **OIDC** only (covers Entra ID, Okta, Google, Keycloak) with `openid-client`; no SAML | One protocol covers the common IdPs; SAML can be a later phase |
| D3 | SSO does **not** auto-create users unless `OIDC_AUTO_CREATE_ROLE` is set (e.g. `client`) | Admins control who gets in by default |
| D4 | MFA = TOTP (authenticator apps) implemented with `node:crypto` (RFC 6238) + 8 one-time recovery codes; secret encrypted at rest with AES-256-GCM (`MFA_ENC_KEY`) | ~40 lines, no dependency; RFC test vectors pin it |
| D5 | Email threading by subject tag `[DSP-#<id>]` **and** `In-Reply-To`/`References` against stored outbound Message-IDs | Tag survives clients that drop headers; headers survive users who edit subjects |
| D6 | One `audit_events` table for ticket history **and** admin/security events | One writer, one query shape; ticket history is a filter on it |
| D7 | Resolved tickets also pause the SLA clock, so Reopen resumes it instead of instantly breaching | Matches ServiceNow/JSM behaviour |
| D8 | Auto-close Resolved tickets after `AUTO_CLOSE_DAYS` (default 7) | ITIL default; env-configurable |

New dependencies allowed by this plan — and no others: backend `multer`, `openid-client`; frontend `qrcode`.

## Global Constraints

- Node `>=26`, Express 5, raw `pg` (no ORM), migrations are `backend/migrations/0NN_name.js` exporting `up(client)`/`down(client)`, numbered from `023` in the order of this plan.
- Every new endpoint uses `requireAuth` except: `POST /api/email/inbound`, `GET /api/auth/oidc/start`, `GET /api/auth/oidc/callback`, `POST /api/auth/forgot`, `POST /api/auth/reset`, `POST /api/auth/mfa/verify`, `GET /api/auth/config`.
- Ticket-scoped endpoints use `requireTicketAccess` (`backend/src/controllers/ticketController.js`) so requester/technician visibility stays in one place.
- Requesters (`REQUESTER_ROLES` = `hr`, `client`) never see internal comments, internal attachments, or internal audit detail.
- Multi-row writes go through `withTransaction` (`backend/src/db/tx.js`); notifications/emails are sent **after** commit.
- No personal data in logs: log ids, not emails or names.
- Unit tests: `npm test` (no DB). Integration tests: `npm run test:int` against database `TEST_DB_NAME` (default `dispatchly_test`), never the dev DB.
- Lint must not get worse: `npx biome lint ./src` error count stays 0.
- Uncommitted SLA work exists in `backend/src/utils/sla.js` and `frontend/src/pages/SlaSettingsPage.jsx` at plan time. Phase 2 builds on whatever is committed when it starts — re-read `sla.js` before Task 2.2.

## Review Focus

1. **Id-guessing across tickets** — a requester requesting `/api/attachments/:id/download`, `/api/tickets/:id/history`, or `/api/tickets/:id/watchers` for someone else's ticket gets 403/404, and never internal rows on their own ticket. Tests in Tasks 1.2, 3.2, 4.3.
2. **Spoofed email reply** — a message with a valid `[DSP-#12]` tag from an address that is neither the requester nor a watcher must not post to ticket 12; it opens a new ticket instead. Test in Task 4.2.
3. **Pause arithmetic** — a ticket paused over a weekend, resumed, paused again and resumed shows the same `minutesRemaining` as if the paused spans never happened, for both the 24/7 and business-hours clocks. Test in Task 2.2.
4. **Hostile uploads** — filename `../../etc/passwd`, `.html`/`.svg` content, 0-byte file, >10 MB file: stored under a random name inside `UPLOAD_DIR`, served with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`, 0-byte rejected 400, oversize 413. Tests in Task 3.1/3.2.
5. **Stale credentials after reset** — a used, expired, or superseded reset token is rejected, and a session cookie issued before the reset gets 401. Test in Task 6.1.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/app.js` (new) | Build the Express app (middleware + routes + error handler); no `listen`, no cron |
| `backend/src/index.js` | `listen` + start background jobs only |
| `backend/src/db/migrate.js` | Export `migrateUp(pool)`; CLI only when run directly |
| `backend/testkit/index.js` (new) | Integration-test helpers (DB reset, app start, users, login, API calls) |
| `backend/int/*.int.test.js` (new) | Integration tests, one file per phase |
| `backend/src/services/audit.js` (new) | `recordAudit` / `diffFields` |
| `backend/src/controllers/auditController.js` (new) | Ticket history + admin audit log |
| `backend/src/services/ticketUpdates.js` (new) | The single path for ticket field/status changes (validation, SLA pause/resume, timestamps, audit) |
| `backend/src/services/autoClose.js` (new) | Hourly auto-close of stale Resolved tickets |
| `backend/src/services/attachmentStore.js` (new) | Save/read/delete files under `UPLOAD_DIR`; multer config |
| `backend/src/controllers/attachmentController.js` (new) | Upload/list/download/delete |
| `backend/src/services/emailThreading.js` (new) | Parse ticket ref from subject/headers, strip quoted replies |
| `backend/src/services/ticketMailer.js` (new) | Outbound ticket emails to requester + watchers, record Message-IDs |
| `backend/src/controllers/watcherController.js` (new) | Watchers CRUD |
| `backend/src/controllers/viewController.js` (new) | Saved views CRUD |
| `backend/src/utils/rateLimit.js` (new) | In-memory limiter extracted from `authController.js` |
| `backend/src/utils/totp.js` (new) | TOTP generate/verify, base32, secret encryption |
| `backend/src/controllers/accountController.js` (new) | Forgot/reset/change password, MFA setup/enable/disable/verify |
| `backend/src/controllers/oidcController.js` (new) | OIDC start/callback, `/auth/config` |
| `frontend/src/pages/TicketDetailPage.jsx` | History tab, attachments, watchers, new statuses, reopen |
| `frontend/src/pages/TicketsPage.jsx` | Search, saved views, bulk select |
| `frontend/src/pages/AuditLogPage.jsx` (new) | Admin audit log |
| `frontend/src/pages/LoginPage.jsx` | SSO button, MFA step, forgot link |
| `frontend/src/pages/ResetPasswordPage.jsx`, `SecurityPage.jsx` (new) | Forgot/reset, MFA enrolment, change password |

---

## Phase 0 — Test harness

### Task 0.1: Split app from server and add integration test kit

**Files:**
- Create: `backend/src/app.js`, `backend/testkit/index.js`, `backend/int/harness.int.test.js`
- Modify: `backend/src/index.js`, `backend/src/db/migrate.js`, `backend/package.json`

**Interfaces:**
- Produces:
  - `createApp(): express.Application` (`src/app.js`) — everything `index.js` does today except `listen` and `*.start()`.
  - `migrateUp(pool: pg.Pool): Promise<number>` (`src/db/migrate.js`) — returns count applied; CLI path unchanged when run as `node src/db/migrate.js up`.
  - testkit: `resetDb(): Promise<void>` (drops/creates `public` schema in `TEST_DB_NAME`, runs `migrateUp`), `startTestApp(): Promise<{ baseUrl: string, close(): Promise<void> }>` (listens on port 0), `createUser({ role, email?, password? = 'password123', name? }): Promise<UserRow>`, `loginAs(baseUrl, user): Promise<string>` (returns `cookie` header value), `api(baseUrl, cookie, method, path, body?): Promise<{ status: number, json: any, headers: Headers }>`, `insertTicket(fields): Promise<TicketRow>` (direct SQL insert with sane defaults).
  - testkit sets `process.env.DB_NAME = process.env.TEST_DB_NAME || 'dispatchly_test'` and a fixed 64-char `JWT_SECRET` **before** requiring `src/db/pool`, and creates the database if missing (connect to `postgres` db, `CREATE DATABASE`).

- [ ] **Step 1: Write the failing test** `int/harness.int.test.js`

```js
test('harness boots app on test DB and logs in', async () => {
  await resetDb();
  const app = await startTestApp();
  const agent = await createUser({ role: 'agent' });
  const cookie = await loginAs(app.baseUrl, agent);
  const me = await api(app.baseUrl, cookie, 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'agent');
  const { rows: [{ db }] } = await require('../src/db/pool').query('SELECT current_database() AS db');
  assert.equal(db, 'dispatchly_test');
  await app.close();
});
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL (`Cannot find module '../testkit'`).
- [ ] **Step 3: Implement** `createApp`, slim `index.js` to `createApp().listen(...)` + `slaMonitor.start(); emailPoller.start(); scheduleManager.start();`, export `migrateUp` (CLI guarded by `require.main === module`), the testkit, and package scripts `"test": "node --test 'src/**/*.test.js'"`, `"test:int": "node --test --test-concurrency=1 'int/**/*.int.test.js'"`.
- [ ] **Step 4: Run** `npm test && npm run test:int` — Expected: all PASS; `node src/index.js` still boots (`✓ Dispatchly API`).
- [ ] **Step 5: Commit** `test: add integration harness and split app from server`

---

## Phase 1 — Audit trail and field history

### Task 1.1: `audit_events` table and writer

**Files:**
- Create: `backend/migrations/023_audit_events.js`, `backend/src/services/audit.js`, `backend/src/services/audit.test.js`

**Interfaces:**
- Produces:
  - Table `audit_events(id BIGSERIAL PK, entity_type TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL, field TEXT, old_value TEXT, new_value TEXT, actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, actor_name TEXT NOT NULL, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`; index `(entity_type, entity_id, created_at)`, index `(created_at)`.
  - `diffFields(before: object, after: object, fields: string[]): Array<{ field, old, new }>` — pure; values stringified, `null` stays `null`, Dates compared by ISO string.
  - `recordAudit(db: Pool|Client, { entityType, entityId, action, actor: { userId?, name }, ip?, changes?: Array<{field, old, new}> }): Promise<void>` — one row per change, or one row with null field when `changes` is empty/absent. `actor.name` `'System'` for jobs.
  - Action names used later: `created`, `updated`, `commented`, `escalated`, `approved`, `rejected`, `attachment_added`, `attachment_deleted`, `watcher_added`, `watcher_removed`, `auto_closed`, `login`, `login_failed`, `password_reset`, `mfa_enabled`, `mfa_disabled`, `user_created`, `user_updated`, `user_deactivated`.

- [ ] **Step 1: Write the failing unit test** `audit.test.js`

```js
test('diffFields reports only changed fields, as strings', () => {
  const d = diffFields({ status: 'New', priority: 'P3', assigned_to_user_id: null },
                       { status: 'In Progress', priority: 'P3', assigned_to_user_id: 7 },
                       ['status', 'priority', 'assigned_to_user_id']);
  assert.deepEqual(d, [
    { field: 'status', old: 'New', new: 'In Progress' },
    { field: 'assigned_to_user_id', old: null, new: '7' },
  ]);
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** migration + `audit.js` (`recordAudit` does one multi-row `INSERT`).
- [ ] **Step 4: Run** `npm test && npm run migrate` — Expected: PASS; `migrate:status` lists `023_audit_events.js` applied.
- [ ] **Step 5: Commit** `feat(audit): add audit_events table and writer`

### Task 1.2: Record ticket/user/auth events; history + audit log APIs

**Files:**
- Create: `backend/src/controllers/auditController.js`, `backend/int/audit.int.test.js`, `frontend/src/pages/AuditLogPage.jsx`
- Modify: `ticketController.js` (create, update, escalate, addComment, accept/decline, convertToKb), `approvalController.js`, `catalogController.js`, `services/emailService.js`, `services/slaMonitor.js` (auto-escalate), `userController.js` (create/update/deactivate), `authController.js` (login, login_failed), `routes/tickets.js`, `app.js` (mount `/api/audit`), `frontend/src/pages/TicketDetailPage.jsx` (History tab), `frontend/src/App.jsx`, `frontend/src/components/layout/Sidebar.jsx`

**Interfaces:**
- Consumes: `recordAudit`, `diffFields` (Task 1.1).
- Produces:
  - `GET /api/tickets/:id/history` (`requireTicketAccess`) → `{ events: AuditRow[] }` oldest first. For requesters: only `action IN ('created','updated','commented','approved','rejected','auto_closed')`, and `updated` only for `field IN ('status','priority','assigned_to_user_id')`; `commented` rows for internal comments excluded (store `new_value = 'internal'|'public'` on `commented`).
  - `GET /api/audit?entity_type&entity_id&actor_user_id&action&from&to&page&limit` (`requireRole('admin')`), `limit` ≤ 200 → `{ events, total }`.
  - Ticket updates record `updated` rows for fields `status, priority, category, title, assigned_to_user_id, kb_article_id` (description/resolution_notes recorded as field name with `old_value/new_value = null` to avoid copying long text).
  - Login records `login`/`login_failed` with `entity_type='user'`, `ip = req.ip`; failed logins for unknown emails use `entity_id = NULL`, never store the attempted email.

- [ ] **Step 1: Write failing integration tests** `audit.int.test.js`

```js
test('status change is recorded with actor and old/new', async () => {
  // agent PATCHes ticket status New → In Progress
  const h = await api(base, agentCookie, 'GET', `/api/tickets/${t.id}/history`);
  const ev = h.json.events.find((e) => e.field === 'status');
  assert.deepEqual([ev.old_value, ev.new_value, ev.actor_name], ['New', 'In Progress', agent.name]);
});
test('requester history hides internal comments and internal fields', async () => {
  // agent posts internal comment + changes category; client fetches own ticket history
  const h = await api(base, clientCookie, 'GET', `/api/tickets/${t.id}/history`);
  assert.ok(!h.json.events.some((e) => e.action === 'commented' && e.new_value === 'internal'));
  assert.ok(!h.json.events.some((e) => e.field === 'category'));
});
test('requester cannot read history of another user ticket', async () => {
  assert.equal((await api(base, otherClientCookie, 'GET', `/api/tickets/${t.id}/history`)).status, 403);
});
test('audit log is admin-only and records failed logins without the email', async () => {
  await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ghost@x.y', password: 'nope' }) });
  assert.equal((await api(base, managerCookie, 'GET', '/api/audit')).status, 403);
  const log = await api(base, adminCookie, 'GET', '/api/audit?action=login_failed');
  assert.ok(log.json.events.length >= 1);
  assert.ok(!JSON.stringify(log.json).includes('ghost@x.y'));
});
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL (404 on `/history`).
- [ ] **Step 3: Implement** the API, the `recordAudit` calls (inside the existing transactions where one exists), a History tab on the ticket page (timeline: "Alex Agent changed status New → In Progress · 2m ago"), and `AuditLogPage` (admin-only table with filters, route `admin/audit`, sidebar link under Admin).
- [ ] **Step 4: Run** `npm test && npm run test:int` — Expected: PASS. Manually: change a ticket in the UI and see it in History.
- [ ] **Step 5: Commit** `feat(audit): record ticket, user and login events; history and audit log views`

---

## Phase 2 — Waiting states, SLA pause, reopen, auto-close

### Task 2.1: Single ticket-update service

**Files:**
- Create: `backend/src/services/ticketUpdates.js`, `backend/int/ticketUpdates.int.test.js`
- Modify: `backend/src/controllers/ticketController.js` (`updateTicket` becomes: access check → `withTransaction(updateTicketFields)` → `notifyTicketChanges` after commit)

**Interfaces:**
- Consumes: `recordAudit`, `diffFields` (1.1), `withTransaction`.
- Produces:
  - `updateTicketFields(client, actor: { userId, name, role }, ticketId: number, changes: object): Promise<{ before: TicketRow, after: TicketRow }>` — locks the row (`SELECT … FOR UPDATE`), applies the same `ALLOWED` rules as today (assignment only for admin/manager), validates `status ∈ TICKET_STATUSES` and `priority ∈ TICKET_PRIORITIES` (throws `{ status: 400 }`), sets `resolved_at`/`closed_at`, `assignment_status`, recomputes `sla_minutes` when priority changes (`SLA_MINUTES[priority]`), writes audit rows. Throws `{ status: 404 }` if missing.
  - `notifyTicketChanges(before, after, actor): Promise<void>` — the notification block moved out of `updateTicket` unchanged.

- [ ] **Step 1: Write failing tests**

```js
test('invalid status is rejected with 400 and nothing changes', async () => {
  const r = await api(base, agentCookie, 'PATCH', `/api/tickets/${t.id}`, { status: 'Bogus' });
  assert.equal(r.status, 400);
  assert.equal((await ticketRow(t.id)).status, 'New');
});
test('priority change recomputes sla_minutes', async () => {
  await api(base, agentCookie, 'PATCH', `/api/tickets/${t.id}`, { priority: 'P1' });
  assert.equal((await ticketRow(t.id)).sla_minutes, 60);
});
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL (`Bogus` currently hits the DB CHECK → 500; priority leaves `sla_minutes` unchanged).
- [ ] **Step 3: Implement** the service and slim `updateTicket` to use it.
- [ ] **Step 4: Run** `npm test && npm run test:int` — Expected: PASS, including Phase 1 audit tests.
- [ ] **Step 5: Commit** `refactor(tickets): route all field changes through updateTicketFields`

### Task 2.2: Pending Customer / On Hold with SLA pause and resume

**Files:**
- Create: `backend/migrations/024_ticket_pause_states.js`, `backend/src/utils/slaPause.test.js`
- Modify: `backend/src/config/constants.js`, `backend/src/utils/sla.js`, `backend/src/services/ticketUpdates.js`, `backend/src/services/slaMonitor.js`, `frontend/src/components/ui/Badge.jsx`, `frontend/src/pages/TicketDetailPage.jsx`, `frontend/src/pages/TicketsPage.jsx` (status filter options)

**Interfaces:**
- Produces:
  - Migration 024: tickets status CHECK adds `'Pending Customer','On Hold'`; tickets add `sla_paused_at TIMESTAMPTZ`, `sla_paused_minutes INTEGER NOT NULL DEFAULT 0`; `ticket_slas` adds `paused_minutes INTEGER NOT NULL DEFAULT 0` (reuses existing `paused_at`).
  - `TICKET_STATUSES` gains `'Pending Customer'`, `'On Hold'`; new `PAUSED_STATUSES = ['Pending Customer','On Hold','Resolved']` (D7).
  - `slaClockMinutes(ticket, start, end, config?): number` in `sla.js` — business minutes for `P3/P4`, wall minutes otherwise (the branch `computeSla` already has, extracted).
  - `computeSla(ticket, bizConfig?, now = new Date())` — elapsed becomes `slaClockMinutes(ticket, created_at, ticket.sla_paused_at ?? now) - ticket.sla_paused_minutes`; returns `isPaused: true, pauseReason: ticket.status` while `sla_paused_at` is set. `computeTicketSla` does the same with `paused_at`/`paused_minutes`.
  - In `updateTicketFields`: entering a paused status sets `sla_paused_at = NOW()` (if null) on the ticket and `paused_at = NOW(), status='paused'` on its active `ticket_slas`; leaving a paused status adds `round(slaClockMinutes(ticket, sla_paused_at, now))` to `sla_paused_minutes` (and the same per `ticket_slas` row), clears the pause, sets `ticket_slas.status='active'`.
  - `slaMonitor.checkPrimarySlas` skips tickets with `sla_paused_at IS NOT NULL`; `checkMultiSlas` already filters `status='active'`.

- [ ] **Step 1: Write failing unit tests** `slaPause.test.js` (pure, explicit `now`)

```js
const cfg = { startHour: 9, endHour: 17, workDays: [1, 2, 3, 4, 5], timezone: 'UTC' };
test('24/7 clock: paused span is excluded', () => {
  const t = { priority: 'P1', status: 'In Progress', sla_minutes: 60,
    created_at: '2026-11-23T10:00:00Z', sla_paused_at: null, sla_paused_minutes: 30 };
  const s = computeSla(t, cfg, new Date('2026-11-23T10:50:00Z'));
  assert.equal(s.elapsedMinutes, 20);
  assert.equal(s.minutesRemaining, 40);
});
test('while paused, remaining time is frozen', () => {
  const t = { priority: 'P1', status: 'Pending Customer', sla_minutes: 60,
    created_at: '2026-11-23T10:00:00Z', sla_paused_at: '2026-11-23T10:10:00Z', sla_paused_minutes: 0 };
  const s = computeSla(t, cfg, new Date('2026-11-24T10:00:00Z'));
  assert.equal(s.minutesRemaining, 50);
  assert.equal(s.isPaused, true);
});
test('business clock: weekend pause then resume keeps remaining unchanged', () => {
  // P3 created Fri 2026-11-20 16:00Z, paused Fri 16:30Z, resumed Mon 09:00Z
  // → paused business minutes = 30 (Fri 16:30–17:00); at Mon 09:30Z elapsed = 30 + 30 = 60
  const t = { priority: 'P3', status: 'In Progress', sla_minutes: 480,
    created_at: '2026-11-20T16:00:00Z', sla_paused_at: null, sla_paused_minutes: 30 };
  assert.equal(computeSla(t, cfg, new Date('2026-11-23T09:30:00Z')).elapsedMinutes, 60);
});
```

- [ ] **Step 2: Add the failing integration test** to `ticketUpdates.int.test.js`

```js
test('pause → resume accumulates paused minutes', async () => {
  await api(base, agentCookie, 'PATCH', `/api/tickets/${t.id}`, { status: 'Pending Customer' });
  await pool.query("UPDATE tickets SET sla_paused_at = NOW() - INTERVAL '45 minutes' WHERE id=$1", [t.id]);
  await api(base, agentCookie, 'PATCH', `/api/tickets/${t.id}`, { status: 'In Progress' });
  const row = await ticketRow(t.id);
  assert.equal(row.sla_paused_at, null);
  assert.ok(row.sla_paused_minutes >= 45);
});
```

  (`t` is a P1 ticket so the 24/7 clock applies.)
- [ ] **Step 3: Run** `npm test && npm run test:int` — Expected: FAIL.
- [ ] **Step 4: Implement** migration, constants, `sla.js`, `ticketUpdates.js`, monitor filter, and UI: new statuses in the status menu, a grey "SLA paused — Pending Customer" chip in `SlaBadge`/`SlaBar` when `sla.isPaused` and `pauseReason`.
- [ ] **Step 5: Run** both suites — Expected: PASS.
- [ ] **Step 6: Commit** `feat(sla): Pending Customer / On Hold statuses pause the SLA clock`

### Task 2.3: Reopen and auto-close

**Files:**
- Create: `backend/src/services/autoClose.js`
- Modify: `backend/src/controllers/ticketController.js` (new `reopenTicket`), `backend/src/routes/tickets.js`, `backend/src/index.js` (start job), `backend/.env.example` (`AUTO_CLOSE_DAYS=7`), `backend/int/ticketUpdates.int.test.js`, `frontend/src/pages/TicketDetailPage.jsx` (Reopen button for requester and staff on Resolved tickets)

**Interfaces:**
- Consumes: `updateTicketFields` (2.1), pause rules (2.2).
- Produces:
  - `POST /api/tickets/:id/reopen { reason: string }` (`requireTicketAccess`) — allowed when status `Resolved` (anyone who can view), or `Closed` with `resolved_at` within `AUTO_CLOSE_DAYS` (staff only); sets status `In Progress`, clears `resolved_at`/`closed_at`, adds a public comment "Reopened: <reason>", notifies assignee. 400 otherwise; `reason` required (1–1000 chars).
  - `runAutoClose(now = new Date()): Promise<number>` — closes tickets `status='Resolved' AND resolved_at < now - AUTO_CLOSE_DAYS`, actor `System`, action `auto_closed`; `start()` schedules it hourly (`'0 * * * *'`).

- [ ] **Step 1: Write failing integration tests**

```js
test('requester reopens a resolved ticket; SLA resumes rather than breaching', async () => {
  // agent resolves; set sla_paused_at back 3 days; client reopens
  const r = await api(base, clientCookie, 'POST', `/api/tickets/${t.id}/reopen`, { reason: 'Still broken' });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'In Progress');
  assert.notEqual(r.json.sla.status, 'Breached');
});
test('reopen without reason → 400; on a New ticket → 400', async () => { /* … */ });
test('runAutoClose closes only stale resolved tickets', async () => {
  // one resolved 8 days ago, one resolved 1 day ago
  assert.equal(await runAutoClose(), 1);
});
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tickets): reopen resolved tickets and auto-close stale ones`

---

## Phase 3 — Attachments

### Task 3.1: Attachment storage

**Files:**
- Create: `backend/migrations/025_attachments.js`, `backend/src/services/attachmentStore.js`, `backend/src/services/attachmentStore.test.js`
- Modify: `backend/package.json` (`multer`), `.gitignore` (`backend/uploads/`), `backend/.env.example` (`UPLOAD_DIR`, `MAX_UPLOAD_MB=10`)

**Interfaces:**
- Produces:
  - Table `attachments(id SERIAL PK, ticket_id INT NOT NULL REFERENCES tickets ON DELETE CASCADE, comment_id INT REFERENCES ticket_comments ON DELETE SET NULL, uploaded_by_user_id INT REFERENCES users ON DELETE SET NULL, uploaded_by_name TEXT NOT NULL, original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, size_bytes INT NOT NULL CHECK (size_bytes > 0), is_internal BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.
  - `uploadMiddleware` — multer disk storage into `UPLOAD_DIR`, filename `crypto.randomUUID()`, limits `{ fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 5 }`, field name `files`.
  - `safeDisplayName(name: string): string` — basename only, strips control chars and path separators, max 200 chars, empty → `'file'`.
  - `INLINE_TYPES = ['image/png','image/jpeg','image/gif','image/webp']` — only these are served inline; everything else `application/octet-stream` + `attachment`.
  - `filePath(storedName): string` — resolves inside `UPLOAD_DIR` and throws if the resolved path escapes it.
  - `saveBuffer({ buffer, originalName, mimeType }): Promise<{ storedName, size }>` — used by email in Phase 4.

- [ ] **Step 1: Write failing unit tests**

```js
test('safeDisplayName strips paths and control characters', () => {
  assert.equal(safeDisplayName('../../etc/passwd'), 'passwd');
  assert.equal(safeDisplayName('C:\\Users\\x\\report.pdf'), 'report.pdf');
  assert.equal(safeDisplayName('a\u0000b.txt'), 'ab.txt');
  assert.equal(safeDisplayName(''), 'file');
});
test('filePath refuses to escape UPLOAD_DIR', () => {
  assert.throws(() => filePath('../secret'));
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** (comment: `shortcut: local disk, single API server; move to S3-compatible storage when running more than one instance`).
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(attachments): storage, limits and safe filenames`

### Task 3.2: Attachment API and UI

**Files:**
- Create: `backend/src/controllers/attachmentController.js`, `backend/int/attachments.int.test.js`
- Modify: `backend/src/routes/tickets.js`, `backend/src/app.js` (mount `GET/DELETE /api/attachments/:id`), `frontend/src/pages/TicketDetailPage.jsx`

**Interfaces:**
- Consumes: Task 3.1 exports, `recordAudit`, `requireTicketAccess`, `canViewTicket`.
- Produces:
  - `POST /api/tickets/:id/attachments` (multipart `files`, optional `is_internal`, optional `comment_id`) → `201 { attachments: AttachmentRow[] }`; requesters forced `is_internal=false`; 0-byte → 400 (file removed); multer `LIMIT_FILE_SIZE` → 413. Audit `attachment_added`.
  - `GET /api/tickets/:id/attachments` → `{ attachments }` (requesters: `is_internal=false` only). Rows never include `stored_name`.
  - `GET /api/attachments/:id/download` — loads row + ticket, `canViewTicket`, internal hidden from requesters (404), sets `Content-Type` (inline type or `application/octet-stream`), `Content-Disposition` (`inline` for `INLINE_TYPES`, else `attachment`; `filename*=UTF-8''<encoded>`), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, streams the file.
  - `DELETE /api/attachments/:id` — uploader or admin/manager; deletes row then file; audit `attachment_deleted`.

- [ ] **Step 1: Write failing integration tests** (use Node's `FormData` + `Blob`)

```js
test('upload, list, download round-trip with safe headers', async () => {
  const up = await upload(base, clientCookie, t.id, [['<script>x</script>', 'evil.html', 'text/html']]);
  assert.equal(up.status, 201);
  const dl = await fetch(`${base}/api/attachments/${up.json.attachments[0].id}/download`, { headers: { cookie: clientCookie } });
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
});
test('internal attachment is invisible to requester, and other users get 403', async () => { /* … */ });
test('0-byte → 400, 11 MB → 413, path-traversal name stored under random name', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL.
- [ ] **Step 3: Implement** API + UI: file input / drag-and-drop on the comment box, attachment list with icon, size and uploader, image thumbnails via the download URL, "Internal" toggle for staff.
- [ ] **Step 4: Run** both suites — Expected: PASS. Manually upload an image and a PDF in the browser.
- [ ] **Step 5: Commit** `feat(attachments): upload, list, download and delete on tickets`

---

## Phase 4 — Two-way email and watchers

### Task 4.1: Threading helpers

**Files:**
- Create: `backend/src/services/emailThreading.js`, `backend/src/services/emailThreading.test.js`

**Interfaces:**
- Produces:
  - `ticketTag(id: number): string` → `` `[DSP-#${id}]` ``.
  - `parseTicketRef({ subject, inReplyTo, references }): { ticketId: number|null, messageIds: string[] }` — tag from subject; `messageIds` = In-Reply-To first, then References entries (whitespace-split, deduped, angle brackets kept).
  - `stripQuotedReply(text: string): string` — cut at the first line matching `/^On .+ wrote:$/`, `/^-{2,}\s*Original Message\s*-{2,}/i`, `/^From: /` after a blank line, or the first line starting with `>`; trim; if the result is empty, return the trimmed input.
  - `normalizeAddress(s: string): string` — lowercase bare address from `"Name <a@b>"` or `a@b`.

- [ ] **Step 1: Write failing unit tests**

```js
test('parseTicketRef reads the tag and header ids', () => {
  assert.deepEqual(
    parseTicketRef({ subject: 'Re: [DSP-#42] Printer', inReplyTo: '<m1@x>', references: '<m0@x> <m1@x>' }),
    { ticketId: 42, messageIds: ['<m1@x>', '<m0@x>'] });
  assert.equal(parseTicketRef({ subject: 'DSP-42 no brackets' }).ticketId, null);
});
test('stripQuotedReply keeps only the new text', () => {
  assert.equal(stripQuotedReply('Works now, thanks!\n\nOn Mon, Nov 23, 2026 Alex wrote:\n> old'), 'Works now, thanks!');
  assert.equal(stripQuotedReply('> only quoted'), '> only quoted');
});
test('normalizeAddress', () => {
  assert.equal(normalizeAddress('Jane Doe <JANE@Ex.com>'), 'jane@ex.com');
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(email): ticket reference parsing and quote stripping`

### Task 4.2: Outbound ticket mail + inbound replies thread into tickets

**Files:**
- Create: `backend/migrations/026_email_threads_watchers.js`, `backend/src/services/ticketMailer.js`, `backend/int/email.int.test.js`
- Modify: `backend/src/services/emailNotifier.js` (`sendNotificationEmail` accepts `{ subject?, replyTo?, headers? }` and returns `info|null`; add `__setTransportForTests(transport)`), `backend/src/services/emailService.js`, `backend/src/services/emailPoller.js` (pass `inReplyTo`, `references`, `cc`, `attachments`), `backend/src/controllers/emailController.js` (accept the same fields; respond `{ ok, ticketId, threaded }`), `backend/src/controllers/ticketController.js` (`addComment` and status notifications call `emailTicketUpdate`), `backend/.env.example` (`SUPPORT_EMAIL`)

**Interfaces:**
- Consumes: Task 4.1, `saveBuffer` (3.1), `updateTicketFields` (2.1), `recordAudit`.
- Produces:
  - Migration 026: `email_messages(message_id TEXT PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets ON DELETE CASCADE, direction TEXT NOT NULL CHECK (direction IN ('in','out')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`; `ticket_watchers(id SERIAL PK, ticket_id INT NOT NULL REFERENCES tickets ON DELETE CASCADE, user_id INT REFERENCES users ON DELETE CASCADE, email TEXT NOT NULL, added_by_user_id INT REFERENCES users ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (ticket_id, email))`; `ticket_comments` adds `source TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal','email'))`.
  - `emailTicketUpdate(ticket, { body: string, kind: 'reply'|'status'|'created', actorEmail?: string }): Promise<void>` — to `requester_email` + watcher emails, deduped via `normalizeAddress`, excluding `actorEmail`; subject `` `${ticketTag(id)} ${title}` ``; `Reply-To: SUPPORT_EMAIL`; stores each returned Message-ID in `email_messages` (`out`). No-op when SMTP is not configured. Never called for internal comments.
  - `createTicketFromEmail({ from, subject, text, messageId, inReplyTo?, references?, cc?, attachments? })` returns `{ ticket, threaded: boolean } | null` (null = duplicate `messageId`):
    1. dedupe on `messageId` against `tickets.email_message_id` **and** `email_messages`;
    2. resolve a ticket by tag, else by any `messageIds` found in `email_messages`;
    3. **thread only if** `normalizeAddress(from)` equals the ticket's normalized `requester_email` or one of its watcher emails — otherwise fall through to step 5 (Review Focus 2);
    4. threaded: insert public comment (`source='email'`, `author` = display name, body = `stripQuotedReply(text)`), save attachments, record inbound Message-ID, and if status is `Pending Customer` or `Resolved` → `In Progress` via `updateTicketFields` with actor `{ userId: null, name: 'Email', role: 'system' }`; notify the assignee;
    5. new ticket: as today, plus `cc` addresses added as watchers (max 20), attachments saved, inbound Message-ID recorded, and `emailTicketUpdate(kind: 'created')` so the requester gets the tag to reply to.

- [ ] **Step 1: Write failing integration tests** (inject nodemailer `{ jsonTransport: true }` via `__setTransportForTests`; `inbound(body)` posts to `/api/email/inbound` with the test `EMAIL_WEBHOOK_SECRET`)

```js
test('reply with tag from requester threads into ticket and resumes SLA', async () => {
  // ticket created from email by jane@ex.com, then set to Pending Customer
  const r = await inbound({ from: 'Jane <JANE@ex.com>', subject: `Re: [DSP-#${t.id}] VPN`,
    text: 'Fixed?\n\nOn Mon X wrote:\n> old', messageId: '<r1@ex>' });
  assert.equal(r.json.threaded, true);
  assert.equal((await ticketRow(t.id)).status, 'In Progress');
  assert.equal((await lastComment(t.id)).body, 'Fixed?');
});
test('reply with a valid tag from a stranger opens a new ticket instead', async () => {
  const r = await inbound({ from: 'mallory@evil.test', subject: `Re: [DSP-#${t.id}] VPN`, text: 'hi', messageId: '<r2@ex>' });
  assert.equal(r.json.threaded, false);
  assert.notEqual(r.json.ticketId, t.id);
});
test('reply matched by In-Reply-To without a tag', async () => { /* outbound id stored, reply references it */ });
test('staff public comment emails requester and watchers; internal note emails nobody', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(email): two-way email threading with requester verification`

### Task 4.3: Watchers API and UI

**Files:**
- Create: `backend/src/controllers/watcherController.js`
- Modify: `backend/src/routes/tickets.js`, `backend/src/utils/ticketAccess.js`, `backend/src/controllers/ticketController.js` (`requireTicketAccess` loads watcher user ids; `getTickets` includes watched tickets for requesters), `backend/src/security.test.js`, `backend/int/email.int.test.js`, `frontend/src/pages/TicketDetailPage.jsx`

**Interfaces:**
- Consumes: `ticket_watchers` (4.2), `recordAudit`.
- Produces:
  - `canViewTicket(user, ticket, watcherUserIds: number[] = [])` — requesters may also view tickets they watch. `getTickets` for requesters: `created_by_user_id = $me OR t.id IN (SELECT ticket_id FROM ticket_watchers WHERE user_id = $me)`.
  - `GET /api/tickets/:id/watchers` → `{ watchers: [{ id, email, name: string|null }] }`; `POST { email }` (staff any ticket; requester on own ticket; max 20 per ticket; basic email format check → 400) links `user_id` when the email belongs to an active user; `DELETE /api/tickets/:id/watchers/:watcherId` (staff, or the watcher themself). Audit `watcher_added`/`watcher_removed`.

- [ ] **Step 1: Write failing tests** — unit in `security.test.js`: `assert.equal(canViewTicket({ role: 'client', userId: 9 }, { created_by_user_id: 1 }, [9]), true)`; integration: a watching client can open the ticket and sees no internal comments; a non-watching client still gets 403; the 21st watcher → 400.
- [ ] **Step 2: Run** both suites — Expected: FAIL.
- [ ] **Step 3: Implement** API + "Watchers" box on the ticket page (chips + add-by-email).
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tickets): watchers with ticket visibility and email updates`

---

## Phase 5 — Search, saved views, bulk actions

### Task 5.1: Full-text search and richer filters

**Files:**
- Create: `backend/migrations/027_ticket_search_views.js`, `backend/int/search.int.test.js`
- Modify: `backend/src/controllers/ticketController.js` (`buildWhere`, `getTickets`), `frontend/src/pages/TicketsPage.jsx`

**Interfaces:**
- Produces:
  - Migration 027: `tickets.search_vector tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title,'')),'A') || setweight(to_tsvector('english', coalesce(description,'')),'B') || to_tsvector('simple', coalesce(requester_name,'') || ' ' || coalesce(requester_email,''))) STORED` + GIN index; `saved_views(id SERIAL PK, user_id INT NOT NULL REFERENCES users ON DELETE CASCADE, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60), filters JSONB NOT NULL, is_shared BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.
  - `GET /api/tickets` query params: `search` (`#123`/`123` → id match; otherwise `search_vector @@ websearch_to_tsquery('english', $n)`, ordered by `ts_rank` desc), `assigned` (`me` | `unassigned` | user id; ignored for requesters), `created_from`, `created_to` (ISO dates; invalid → 400), `sort` (`created_desc` default | `created_asc` | `priority` | `updated_desc`), `limit` clamped 1–100, `page` ≥ 1; non-numeric `limit`/`page` → defaults (fixes the current `NaN` 500).

- [ ] **Step 1: Write failing tests**

```js
test('search uses stemming and ranks title matches first', async () => {
  // ticket A title 'Printer jammed'; ticket B description mentions 'printers'
  const r = await api(base, agentCookie, 'GET', '/api/tickets?search=printing');
  assert.equal(r.json.tickets[0].title, 'Printer jammed');
  assert.equal(r.json.total, 2);
});
test('#id search, assigned=me, and bad limit/page do not 500', async () => { /* … */ });
test('requester search never returns other users tickets', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL.
- [ ] **Step 3: Implement** + UI (search box placeholder "Search tickets or #123", assignee/date/sort controls, all reflected in the URL so loaders and saved views share one format).
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(search): full-text ticket search and richer filters`

### Task 5.2: Saved views

**Files:**
- Create: `backend/src/controllers/viewController.js`
- Modify: `backend/src/app.js` (mount `/api/views`), `backend/int/search.int.test.js`, `frontend/src/pages/TicketsPage.jsx`, `frontend/src/components/layout/Sidebar.jsx`

**Interfaces:**
- Consumes: `saved_views` (5.1), the 5.1 query keys.
- Produces: `GET /api/views` → own + shared; `POST /api/views { name, filters, is_shared }` (`is_shared` only for admin/manager, else 403) → `201 { view }`; `DELETE /api/views/:id` (owner, or admin for shared; else 403). `filters` keeps only the 5.1 query keys (`status, priority, type, category, search, assigned, created_from, created_to, sort`); serialized size ≤ 2 KB → else 400.

- [ ] **Step 1: Write failing tests** — create/list/delete round-trip; agent creating `is_shared: true` → 403; another user deleting → 403; `{ filters: { status: 'New', evil: 'x' } }` stores only `status`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** + UI ("Save view" button on the Tickets page; views listed under Tickets in the sidebar; selecting one navigates to `/tickets?<filters>`).
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tickets): saved and shared ticket views`

### Task 5.3: Bulk actions

**Files:**
- Modify: `backend/src/controllers/ticketController.js` (new `bulkUpdateTickets`), `backend/src/routes/tickets.js` (`POST /bulk`, declared **before** the `/:id` routes), `backend/int/search.int.test.js`, `frontend/src/pages/TicketsPage.jsx`

**Interfaces:**
- Consumes: `updateTicketFields`, `notifyTicketChanges` (2.1), `canViewTicket`.
- Produces: `POST /api/tickets/bulk { ticket_ids: number[] (1–100, unique), changes: { status?, priority?, assigned_to_user_id? } }` — staff roles only (`requireRole`); each ticket in its own `withTransaction(updateTicketFields)`; tickets the user can't view → skipped `reason: 'forbidden'`, validation errors → skipped with the message; response `200 { updated: number[], skipped: [{ id, reason }] }`; notifications after each commit.

- [ ] **Step 1: Write failing tests** — agent bulk-sets 3 tickets to `Closed` → `updated.length === 3` and 3 `status` audit rows; technician including an unassigned ticket → that id in `skipped` with `reason: 'forbidden'`; 101 ids → 400; requester → 403.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** + UI (row checkboxes, select-all for the page, sticky action bar: Assign / Status / Priority, result toast "Updated 3, skipped 1").
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(tickets): bulk status, priority and assignment`

---

## Phase 6 — Identity: password reset, MFA, SSO

### Task 6.1: Password reset, change password, session invalidation

**Files:**
- Create: `backend/migrations/028_auth_security.js`, `backend/src/utils/rateLimit.js`, `backend/src/controllers/accountController.js`, `backend/int/auth.int.test.js`, `frontend/src/pages/ResetPasswordPage.jsx`, `frontend/src/pages/SecurityPage.jsx`
- Modify: `backend/src/controllers/authController.js` (use `rateLimit.js`; extract `issueSession(res, user)`), `backend/src/middleware/auth.js`, `backend/src/routes/auth.js`, `frontend/src/pages/LoginPage.jsx`, `frontend/src/App.jsx`

**Interfaces:**
- Produces:
  - Migration 028: `users` adds `password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `mfa_secret_enc TEXT`, `mfa_enabled_at TIMESTAMPTZ`, `mfa_last_step BIGINT`, `mfa_recovery_hashes TEXT[]`, `auth_provider TEXT NOT NULL DEFAULT 'password'`; `password_reset_tokens(id SERIAL PK, user_id INT NOT NULL REFERENCES users ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.
  - `createLimiter({ limit, windowMs }): { isBlocked(key): boolean, fail(key): void, reset(key): void }` — the existing login limiter moved here, same behaviour.
  - `issueSession(res, user): object` (in `authController.js`) — signs the JWT, sets the cookie, returns the payload.
  - `requireAuth` additionally loads `password_changed_at` and rejects a token whose `iat * 1000 < password_changed_at` (with 1 s tolerance) → 401 "Session expired".
  - `POST /api/auth/forgot { email }` → always `200 { ok: true }`; for an active `auth_provider='password'` user: 32 random bytes, stored as sha256 hex, 60-minute expiry, older unused tokens marked used, emails `APP_URL/reset-password?token=…`; limited 5/IP/15 min (429).
  - `POST /api/auth/reset { token, password }` → 400 for unknown/used/expired token or password < 8 chars; sets hash and `password_changed_at = NOW()`, marks token used, audit `password_reset`.
  - `POST /api/auth/change-password { current_password, new_password }` (`requireAuth`) → 400 on wrong current password; sets `password_changed_at` then calls `issueSession` so the caller stays signed in.

- [ ] **Step 1: Write failing tests**

```js
test('reset flow: token works once, old session dies, no user enumeration', async () => {
  const unknown = await post('/api/auth/forgot', { email: 'nobody@x.y' });
  const known = await post('/api/auth/forgot', { email: client.email });
  assert.deepEqual([unknown.status, unknown.json], [known.status, known.json]);
  const token = lastResetTokenFromTestMailbox();
  assert.equal((await post('/api/auth/reset', { token, password: 'newpass123' })).status, 200);
  assert.equal((await post('/api/auth/reset', { token, password: 'again12345' })).status, 400);
  assert.equal((await api(base, oldClientCookie, 'GET', '/api/auth/me')).status, 401);
});
test('expired token → 400; superseded token → 400', async () => { /* … */ });
test('change-password keeps the caller signed in but kills other sessions', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL.
- [ ] **Step 3: Implement** + UI ("Forgot password?" on login, reset page, Security page with change-password form; route `security` for all roles).
- [ ] **Step 4: Run** both suites — Expected: PASS (existing `security.test.js` still passes).
- [ ] **Step 5: Commit** `feat(auth): password reset, change password, invalidate old sessions`

### Task 6.2: TOTP MFA

**Files:**
- Create: `backend/src/utils/totp.js`, `backend/src/utils/totp.test.js`
- Modify: `backend/src/controllers/accountController.js`, `backend/src/controllers/authController.js`, `backend/src/controllers/userController.js` (`reset_mfa`), `backend/src/routes/auth.js`, `backend/.env.example` (`MFA_ENC_KEY`, `MFA_REQUIRED_ROLES`), `backend/int/auth.int.test.js`, `frontend/package.json` (`qrcode`), `frontend/src/pages/LoginPage.jsx`, `frontend/src/pages/SecurityPage.jsx`

**Interfaces:**
- Produces:
  - `totp.js`: `base32Encode(buf: Buffer): string`, `base32Decode(str: string): Buffer`, `generateSecret(): string` (20 random bytes, base32), `totpAt(secretB32: string, step: number): string` (HMAC-SHA1, 6 digits, zero-padded), `verifyTotp(secretB32, code, nowMs = Date.now(), lastStep = null): number|null` (accepts steps `now-1..now+1`, returns the matched step, rejects `step <= lastStep`), `encryptSecret(plain): string` / `decryptSecret(enc): string` (AES-256-GCM, key = `MFA_ENC_KEY` as 64 hex chars, output `base64(iv).base64(tag).base64(ciphertext)`; throws on tamper).
  - Login: password OK and `mfa_enabled_at` set → `200 { mfaRequired: true }` + cookie `dispatchly_mfa` (JWT `{ userId, purpose: 'mfa' }`, 5 min, httpOnly); no session cookie. Role in `MFA_REQUIRED_ROLES` (comma list) and not enrolled → `200 { mfaSetupRequired: true }` + `dispatchly_mfa` with `purpose: 'mfa_setup'`.
  - `POST /api/auth/mfa/verify { code }` (needs `dispatchly_mfa` purpose `mfa`; limiter 5/user/15 min) → TOTP via `verifyTotp`, or an unused recovery code (bcrypt compare, then removed) → `issueSession`, stores `mfa_last_step`, clears `dispatchly_mfa`, audit `login`.
  - `POST /api/auth/mfa/setup` (session **or** `mfa_setup` cookie) → `{ otpauthUrl, secret }` (secret stored encrypted, not yet enabled; issuer `Dispatchly`); `POST /api/auth/mfa/enable { code }` → `{ recoveryCodes: string[] }` (8 codes, 10 chars from `[a-z0-9]`, shown once, stored bcrypt-hashed), sets `mfa_enabled_at`, audit `mfa_enabled`, issues a session when called with the `mfa_setup` cookie; `POST /api/auth/mfa/disable { password, code }` → clears MFA, audit `mfa_disabled`; admin `PATCH /api/users/:id { reset_mfa: true }` clears another user's MFA (audit `user_updated`, field `mfa`).

- [ ] **Step 1: Write failing unit tests** with RFC 6238 SHA-1 vectors (secret = ASCII `12345678901234567890`)

```js
test('RFC 6238 vectors', () => {
  const s = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(s, Math.floor(59 / 30)), '287082');
  assert.equal(totpAt(s, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpAt(s, Math.floor(1234567890 / 30)), '005924');
});
test('verifyTotp rejects replay of the same step and codes two steps away', () => { /* … */ });
test('encrypt/decrypt round-trip; tampered ciphertext throws', () => { /* … */ });
```

- [ ] **Step 2: Add failing integration tests** — enrolled user logs in → `mfaRequired`, `/api/auth/me` without verify → 401; wrong code ×5 → 429 on the 6th; a recovery code works once; with `MFA_REQUIRED_ROLES=admin` an unenrolled admin gets `mfaSetupRequired` and no session until `enable`.
- [ ] **Step 3: Run** both suites — Expected: FAIL.
- [ ] **Step 4: Implement** + UI (login code step with "Use a recovery code" link; Security page: QR rendered from `otpauthUrl` with `qrcode`, confirm-code field, recovery codes shown once with Copy/Download).
- [ ] **Step 5: Run** both suites — Expected: PASS.
- [ ] **Step 6: Commit** `feat(auth): TOTP multi-factor authentication with recovery codes`

### Task 6.3: OIDC single sign-on

**Files:**
- Create: `backend/src/controllers/oidcController.js`
- Modify: `backend/package.json` (`openid-client`), `backend/src/routes/auth.js`, `backend/src/controllers/authController.js` (`PASSWORD_LOGIN_ENABLED`), `backend/.env.example` (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_LABEL`, `OIDC_AUTO_CREATE_ROLE`, `PASSWORD_LOGIN_ENABLED=true`), `backend/int/auth.int.test.js`, `frontend/src/pages/LoginPage.jsx`, `README.md` (SSO setup section)

**Interfaces:**
- Consumes: `issueSession` (6.1), `recordAudit`. MFA is **skipped** for OIDC logins (the IdP owns MFA).
- Produces:
  - `GET /api/auth/config` → `{ sso: boolean, ssoLabel: string, passwordLogin: boolean }` (`sso` true when `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set; `ssoLabel` from `OIDC_LABEL`, default `'SSO'`).
  - `GET /api/auth/oidc/start` → 302 to the IdP with PKCE (S256), `state`, `nonce` held in a 10-minute httpOnly `dispatchly_oidc` cookie (signed JWT).
  - `GET /api/auth/oidc/callback` → validates state/nonce/PKCE with `openid-client`; requires `email` and `email_verified !== false`; finds an active user by lowercased email, or creates one with `OIDC_AUTO_CREATE_ROLE` when set (`auth_provider='oidc'`, random unusable password hash); `issueSession`; audit `login` with `new_value='oidc'`; 302 to `APP_URL`. Unknown user with no auto-create → 302 `APP_URL/login?error=sso_no_account`. State mismatch → 400, no cookie.
  - `PASSWORD_LOGIN_ENABLED=false` → `POST /api/auth/login` returns 403 for every role except `admin` (break-glass).

- [ ] **Step 1: Write failing integration tests** against a mock IdP started inside the test: an `http` server serving `/.well-known/openid-configuration`, `/jwks`, `/authorize` (302 back with a code), `/token` (id_token signed RS256 with a key from `crypto.generateKeyPairSync('rsa')`).

```js
test('SSO login for an existing user issues a session', async () => { /* follow the redirects manually, then GET /api/auth/me → 200 */ });
test('tampered state → 400 and no session cookie', async () => { /* … */ });
test('unknown email without auto-create redirects with sso_no_account', async () => { /* … */ });
test('PASSWORD_LOGIN_ENABLED=false blocks agent password login but not admin', async () => { /* … */ });
```

- [ ] **Step 2: Run** `npm run test:int` — Expected: FAIL.
- [ ] **Step 3: Implement** + "Sign in with <ssoLabel>" button on the login page when `config.sso`, hide the password form when `passwordLogin` is false (keep an "Admin sign-in" link), message for `?error=sso_no_account`, README SSO section (Entra ID, Okta, Google redirect URI examples).
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): OIDC single sign-on`

---

## Execution notes

- Dependency order: 0 → 1 → 2 → (3 and 6 can run in parallel) → 4 (needs 2 and 3) → 5 (needs 1 and 2).
- Each phase ends deployable; run `npm run migrate` after pulling it.
- After each phase: `npm test`, `npm run test:int`, `npx biome lint ./src` (0 errors), and one manual pass through that phase's UI in the browser.
