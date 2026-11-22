const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startTestApp, createUser, loginAs, api } = require('../testkit');

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
  await require('../src/db/pool').end();
});
