// Security regression checks — run with `npm test` (no DB needed).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('JWT_SECRET guard: server refuses to load with missing/weak/placeholder secret', () => {
  const load = (secret) =>
    execFileSync(process.execPath, ['-e', "require('./src/middleware/auth')"], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, JWT_SECRET: secret },
      stdio: 'pipe',
    });
  assert.throws(() => load(''));
  assert.throws(() => load('short'));
  assert.throws(() => load('changeme_use_a_long_random_string_padding'));
  assert.doesNotThrow(() => load('a'.repeat(64)));
});

test('canViewTicket enforces requester / technician visibility', () => {
  const { canViewTicket } = require('./utils/ticketAccess');
  const ticket = { created_by_user_id: 1, assigned_to_user_id: 2 };
  assert.equal(canViewTicket({ role: 'client', userId: 1 }, ticket), true);
  assert.equal(canViewTicket({ role: 'client', userId: 9 }, ticket), false);
  assert.equal(canViewTicket({ role: 'hr', userId: 9 }, ticket), false);
  assert.equal(canViewTicket({ role: 'technician', userId: 2 }, ticket), true);
  assert.equal(canViewTicket({ role: 'technician', userId: 9 }, ticket), false);
  assert.equal(canViewTicket({ role: 'agent', userId: 9 }, ticket), true);
});

test('notification email HTML escapes the ticket title and message', () => {
  const { buildHtml } = require('./services/emailNotifier');
  const html = buildHtml({
    message: '<img src=x>',
    ticketId: 1,
    ticketTitle: '<a href="https://evil.example">Reset password</a>',
    type: 'new_ticket',
  });
  assert.ok(!html.includes('<a href="https://evil.example">'));
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;a href=&quot;https://evil.example&quot;&gt;'));
});
