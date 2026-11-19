// Time-handling regression checks — run with `npm test` (no DB needed).
const test = require('node:test');
const assert = require('node:assert');

test('inShiftNow uses the schedule time zone, not the server clock', () => {
  const { inShiftNow } = require('./services/scheduleManager');
  const ny = { timezone: 'America/New_York', work_days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 17 };
  // Monday 2026-11-23: 14:00Z = 09:00 EST (in shift), 13:59Z = 08:59 EST (not yet)
  assert.equal(inShiftNow(ny, new Date('2026-11-23T14:00:00Z')), true);
  assert.equal(inShiftNow(ny, new Date('2026-11-23T13:59:00Z')), false);
  // Saturday is never in shift
  assert.equal(inShiftNow(ny, new Date('2026-11-21T16:00:00Z')), false);
  // A bad time zone string falls back to UTC instead of crashing the cron
  const bad = { ...ny, timezone: 'Not/AZone' };
  assert.equal(inShiftNow(bad, new Date('2026-11-23T10:00:00Z')), true);
});

test('businessMinutesElapsed skips nights and weekends', () => {
  const { businessMinutesElapsed } = require('./utils/sla');
  const cfg = { startHour: 9, endHour: 17, workDays: [1, 2, 3, 4, 5] };
  // Fri 2026-11-20 16:00 → Mon 2026-11-23 10:00 (server-local): 60 Fri + 60 Mon
  const fri = new Date(2026, 10, 20, 16, 0);
  const mon = new Date(2026, 10, 23, 10, 0);
  assert.equal(businessMinutesElapsed(fri, mon, cfg), 120);
  assert.equal(businessMinutesElapsed(mon, fri, cfg), 0); // end before start
});
