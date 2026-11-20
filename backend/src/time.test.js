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
  const cfg = { startHour: 9, endHour: 17, workDays: [1, 2, 3, 4, 5], timezone: 'UTC' };
  // Fri 2026-11-20 16:00 → Mon 2026-11-23 10:00 UTC: 60 Fri + 60 Mon
  const fri = new Date('2026-11-20T16:00:00Z');
  const mon = new Date('2026-11-23T10:00:00Z');
  assert.equal(businessMinutesElapsed(fri, mon, cfg), 120);
  assert.equal(businessMinutesElapsed(mon, fri, cfg), 0); // end before start
  // Mid-hour start/end inside one business day
  assert.equal(businessMinutesElapsed(new Date('2026-11-23T09:30:15Z'), new Date('2026-11-23T11:00:15Z'), cfg), 90);
});

test('business hours are read in the configured time zone, not the server clock', () => {
  const { businessMinutesElapsed, isCurrentlyInBusinessHours } = require('./utils/sla');
  const ny = { startHour: 9, endHour: 17, workDays: [1, 2, 3, 4, 5], timezone: 'America/New_York' };
  // Mon 2026-11-23 12:00Z = 07:00 EST → 16:00Z = 11:00 EST: only 09:00–11:00 EST counts
  assert.equal(businessMinutesElapsed(new Date('2026-11-23T12:00:00Z'), new Date('2026-11-23T16:00:00Z'), ny), 120);
  // Fri 21:00Z = 16:00 EST → Mon 15:00Z = 10:00 EST: 60 Fri + 60 Mon (weekend skipped in NY time)
  assert.equal(businessMinutesElapsed(new Date('2026-11-20T21:00:00Z'), new Date('2026-11-23T15:00:00Z'), ny), 120);
  // Half-hour zone: 09:00 IST = 03:30Z
  const india = { ...ny, timezone: 'Asia/Kolkata' };
  assert.equal(businessMinutesElapsed(new Date('2026-11-23T03:00:00Z'), new Date('2026-11-23T04:30:00Z'), india), 60);
  assert.equal(isCurrentlyInBusinessHours(ny, new Date('2026-11-23T14:00:00Z')), true);  // 09:00 EST
  assert.equal(isCurrentlyInBusinessHours(ny, new Date('2026-11-23T13:59:00Z')), false); // 08:59 EST
});
