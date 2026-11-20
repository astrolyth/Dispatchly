const test = require('node:test');
const assert = require('node:assert');
const { businessHoursError, slaDefinitionError } = require('./controllers/dashboardController');

test('businessHoursError accepts valid config and rejects bad hours, days and zones', () => {
  const ok = { start_hour: 9, end_hour: 17, work_days: [1, 2, 3, 4, 5], timezone: 'America/Chicago' };
  assert.equal(businessHoursError(ok), null);
  assert.ok(businessHoursError({ ...ok, end_hour: 9 }));
  assert.ok(businessHoursError({ ...ok, end_hour: 25 }));
  assert.ok(businessHoursError({ ...ok, start_hour: 8.5 }));
  assert.ok(businessHoursError({ ...ok, work_days: [] }));
  assert.ok(businessHoursError({ ...ok, work_days: [7] }));
  assert.ok(businessHoursError({ ...ok, timezone: 'Mars/Olympus' }));
});

test('slaDefinitionError checks type, target and filters only when present', () => {
  assert.equal(slaDefinitionError({ is_active: false }), null);
  assert.equal(slaDefinitionError({ type: 'OLA', target_minutes: 30, priority_filter: ['P1'], category_filter: null }), null);
  assert.ok(slaDefinitionError({ type: 'XYZ' }));
  assert.ok(slaDefinitionError({ target_minutes: 0 }));
  assert.ok(slaDefinitionError({ target_minutes: '60' }));
  assert.ok(slaDefinitionError({ priority_filter: 'P1' }));
});
