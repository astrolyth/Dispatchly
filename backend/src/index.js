require('dotenv').config();
const pool = require('./db/pool');
const { createApp } = require('./app');
const emailPoller     = require('./services/emailPoller');
const slaMonitor      = require('./services/slaMonitor');
const scheduleManager = require('./services/scheduleManager');

const PORT = process.env.PORT || 3001;

// ─── Start ────────────────────────────────────────────────────────────────────

createApp().listen(PORT, async () => {
  try {
    await pool.query('SELECT 1');
    console.log(`✓ Database connected`);
  } catch (err) {
    console.error(`✗ Database connection failed: ${err.message}`);
  }
  console.log(`✓ Dispatchly API → http://localhost:${PORT}`);

  // Start background services
  slaMonitor.start();
  emailPoller.start();
  scheduleManager.start(); // auto status transitions every minute
});
