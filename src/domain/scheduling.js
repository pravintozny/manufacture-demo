import { ConflictError } from '../errors.js';

const DAY = 1440;          // minutes
const SHIFT_START = 480;   // 08:00 UTC
export const MAX_SCAN_DAYS = 5000;

/**
 * Finite-capacity allocation on a work center calendar (Mon-Fri, shift starts 08:00 UTC, `capMinutes` long).
 * Times are minutes since the Unix epoch. Work spills over into following working days.
 */
export function allocate(capMinutes, earliest, duration) {
  if (duration <= 0) return { start: earliest, end: earliest };
  if (!(capMinutes > 0)) throw new ConflictError('Work center has no capacity');
  let t = earliest;
  let remaining = duration;
  let start = null;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const day = Math.floor(t / DAY);
    const dow = (day + 4) % 7; // 1970-01-01 was a Thursday; 0=Sun
    if (dow === 0 || dow === 6) { t = (day + 1) * DAY; continue; }
    const shiftStart = day * DAY + SHIFT_START;
    const shiftEnd = shiftStart + capMinutes;
    if (t < shiftStart) t = shiftStart;
    if (t >= shiftEnd) { t = (day + 1) * DAY; continue; }
    if (start === null) start = t;
    const use = Math.min(remaining, shiftEnd - t);
    t += use;
    remaining -= use;
    if (remaining <= 1e-9) return { start, end: t };
    t = (day + 1) * DAY;
  }
  throw new ConflictError('Unable to schedule within planning horizon');
}

export const toMinutes = (iso) => new Date(iso).getTime() / 60000;
export const toIso = (min) => new Date(min * 60000).toISOString();
