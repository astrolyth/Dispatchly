const { ESCALATION_TEAMS } = require('../config/constants');

// ─── Business Hours Configuration ────────────────────────────────────────────

/**
 * Default business hours config.
 * This is overridden at runtime by the value loaded from business_hours_config table.
 * workDays: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
 */
const DEFAULT_BIZ_HOURS = {
  startHour: 9,
  endHour: 17,
  workDays: [1, 2, 3, 4, 5], // Mon–Fri
  timezone: 'UTC',
};

// ─── Wall-clock time in a given IANA time zone ───────────────────────────────

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const _formatters = new Map(); // tz → Intl.DateTimeFormat (construction is slow; reuse)

function formatterFor(timeZone) {
  const tz = timeZone || 'UTC';
  if (!_formatters.has(tz)) {
    const opts = {
      weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    };
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz });
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }); // invalid tz string
    }
    _formatters.set(tz, fmt);
  }
  return _formatters.get(tz);
}

/** Local { day (0=Sun), hour, minute, second } of `date` in `timeZone`. Bad zones fall back to UTC. */
function localTime(timeZone, date = new Date()) {
  const p = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map((x) => [x.type, x.value]));
  return { day: WEEKDAYS[p.weekday], hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second) };
}

// Module-level cache — updated by loadBusinessHoursConfig()
let _bizHoursConfig = { ...DEFAULT_BIZ_HOURS };

/**
 * Update the cached business hours config.
 * Called at server startup and periodically by slaMonitor.
 */
function setBusinessHoursConfig(config) {
  if (config) {
    _bizHoursConfig = {
      startHour: config.start_hour ?? DEFAULT_BIZ_HOURS.startHour,
      endHour:   config.end_hour   ?? DEFAULT_BIZ_HOURS.endHour,
      workDays:  config.work_days  ?? DEFAULT_BIZ_HOURS.workDays,
      timezone:  config.timezone   ?? DEFAULT_BIZ_HOURS.timezone,
    };
  }
}

function getBusinessHoursConfig() {
  return _bizHoursConfig;
}

// ─── Business Minutes Calculation ────────────────────────────────────────────

/**
 * Calculate how many business minutes have elapsed between two dates.
 * Only counts minutes that fall within configured business hours.
 *
 * Hours and days are read in config.timezone, not the server clock. Walks in local-hour
 * steps (re-reading the wall clock each step), so DST shifts and :30 zones stay correct.
 * Cost is ~one step per off-hour; fine for tickets open weeks, not years.
 *
 * @param {Date|string} start
 * @param {Date|string} end
 * @param {object} [config]   Defaults to _bizHoursConfig
 * @returns {number} Elapsed business minutes
 */
function businessMinutesElapsed(start, end, config = _bizHoursConfig) {
  const { startHour, endHour, workDays, timezone } = config;
  const HOUR = 3600000;
  let t = new Date(start).getTime();
  const endT = new Date(end).getTime();
  let totalMs = 0;

  while (t < endT) {
    const { day, hour, minute, second } = localTime(timezone, new Date(t));
    const intoHour = (minute * 60 + second) * 1000 + (t % 1000);
    const hourStart = t - intoHour; // start of the current local hour

    if (workDays.includes(day) && hour >= startHour && hour < endHour) {
      // Inside business hours — count up to local closing time (or end)
      const segEnd = Math.min(endT, hourStart + (endHour - hour) * HOUR);
      totalMs += segEnd - t;
      t = segEnd;
    } else {
      t = hourStart + HOUR; // jump to the next local hour and re-check
    }
  }

  return totalMs / 60000;
}

// ─── Priorities that respect business hours ───────────────────────────────────

// P1 / P2 = critical / high — SLA clock runs 24/7
// P3 / P4 = standard / low  — SLA clock pauses outside business hours
const BUSINESS_HOURS_PRIORITIES = new Set(['P3', 'P4']);

// ─── Core SLA computation ────────────────────────────────────────────────────

/**
 * Compute real-time SLA status from a ticket row.
 * Pure JS — no DB call needed.
 *
 * @param {object} ticket   Must have: status, priority, created_at, sla_minutes
 * @param {object} [bizConfig]  Override business hours config (optional)
 * @returns {{ status, minutesRemaining, percentElapsed, pct, elapsedMinutes, isBusinessHours }}
 */
function computeSla(ticket, bizConfig) {
  const config = bizConfig ?? _bizHoursConfig;

  if (['Resolved', 'Closed'].includes(ticket.status)) {
    return {
      status: 'Resolved',
      minutesRemaining: null,
      percentElapsed: 100,
      pct: 100,
      elapsedMinutes: null,
      isBusinessHours: false,
    };
  }

  const now = new Date();
  const createdAt = new Date(ticket.created_at);
  const total = ticket.sla_minutes;

  // Choose clock type based on priority
  const useBusinessHours = BUSINESS_HOURS_PRIORITIES.has(ticket.priority);
  const elapsed = useBusinessHours
    ? businessMinutesElapsed(createdAt, now, config)
    : (now - createdAt) / 60000;

  const remaining = total - elapsed;
  const pct = total > 0 ? Math.min(200, (elapsed / total) * 100) : 0; // cap at 200% for display

  // Determine if we're currently in business hours
  const isInBizHours = isCurrentlyInBusinessHours(config);

  return {
    status: remaining < 0 ? 'Breached' : pct >= 75 ? 'At Risk' : 'On Track',
    minutesRemaining: Math.round(remaining),
    percentElapsed: Math.round(Math.min(100, pct)),
    pct: Math.round(pct),
    elapsedMinutes: Math.round(elapsed),
    isBusinessHours: useBusinessHours,
    isPaused: useBusinessHours && !isInBizHours,
  };
}

/**
 * Check if the current moment is within business hours.
 */
function isCurrentlyInBusinessHours(config = _bizHoursConfig, now = new Date()) {
  const { day, hour } = localTime(config.timezone, now);
  return (
    config.workDays.includes(day) &&
    hour >= config.startHour &&
    hour < config.endHour
  );
}

// ─── Compute SLA for a specific ticket_slas record ───────────────────────────

/**
 * Compute elapsed business minutes for a ticket_slas row.
 * Used by the SLA monitor to check multi-SLA breaches.
 *
 * @param {object} ticketSla  Row from ticket_slas table
 * @param {object} slaDef     Row from sla_definitions table
 * @returns {{ elapsed, remaining, pct, status }}
 */
function computeTicketSla(ticketSla, slaDef) {
  const now = new Date();
  const config = slaDef.applies_business_hours ? _bizHoursConfig : null;

  const elapsed = config
    ? businessMinutesElapsed(ticketSla.started_at, now, config)
    : (now - new Date(ticketSla.started_at)) / 60000;

  const remaining = slaDef.target_minutes - elapsed;
  const pct = slaDef.target_minutes > 0
    ? Math.min(200, (elapsed / slaDef.target_minutes) * 100)
    : 0;

  return {
    elapsed: Math.round(elapsed),
    remaining: Math.round(remaining),
    pct: Math.round(pct),
    status: remaining < 0 ? 'breached' : pct >= 75 ? 'at_risk' : 'active',
  };
}

// ─── Enrich helper ───────────────────────────────────────────────────────────

/**
 * Attach computed SLA + suggested escalation team to a ticket row.
 */
function enrich(ticket) {
  return {
    ...ticket,
    sla: computeSla(ticket),
    suggestedEscalationTeam: ESCALATION_TEAMS[ticket.category] ?? null,
  };
}

module.exports = {
  computeSla,
  computeTicketSla,
  enrich,
  businessMinutesElapsed,
  isCurrentlyInBusinessHours,
  localTime,
  setBusinessHoursConfig,
  getBusinessHoursConfig,
  DEFAULT_BIZ_HOURS,
};
