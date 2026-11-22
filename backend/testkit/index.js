// Integration test kit. Env must be set before src/db/pool is first required.
const TEST_DB = process.env.TEST_DB_NAME || 'dispatchly_test';
process.env.DB_NAME = TEST_DB;
process.env.JWT_SECRET = 'testkit-jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEF';

const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const pool = require('../src/db/pool');
const { migrateUp } = require('../src/db/migrate');
const { createApp } = require('../src/app');

let seq = 0;

async function ensureDatabase() {
  const admin = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
}

async function resetDb() {
  await ensureDatabase();
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  if (db !== TEST_DB) throw new Error(`resetDb refused: connected to "${db}", expected "${TEST_DB}"`);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrateUp(pool);
}

async function startTestApp() {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function createUser({ role, email, password = 'password123', name } = {}) {
  const n = ++seq;
  const hash = await bcrypt.hash(password, 4);
  const { rows: [user] } = await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING *',
    [email || `user${n}-${Date.now()}@test.local`, hash, name || `Test ${role} ${n}`, role],
  );
  user.password = password;
  return user;
}

async function loginAs(baseUrl, user) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password || 'password123' }),
  });
  if (res.status !== 200) throw new Error(`loginAs failed: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function api(baseUrl, cookie, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(cookie && { Cookie: cookie }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body: leave json null
  }
  return { status: res.status, json, headers: res.headers };
}

async function insertTicket(fields = {}) {
  const row = { requester_name: 'Test Requester', title: 'Test ticket', description: 'Test description', ...fields };
  const cols = Object.keys(row);
  const { rows: [ticket] } = await pool.query(
    `INSERT INTO tickets (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    cols.map((c) => row[c]),
  );
  return ticket;
}

module.exports = { resetDb, startTestApp, createUser, loginAs, api, insertTicket };
