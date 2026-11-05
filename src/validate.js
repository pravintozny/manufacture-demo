import { ValidationError } from './errors.js';

export function str(v, name, { optional = false, max = 200 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw new ValidationError(`${name} is required`);
  }
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
  const t = v.trim();
  if (!t) throw new ValidationError(`${name} must not be blank`);
  if (t.length > max) throw new ValidationError(`${name} must be at most ${max} characters`);
  return t;
}

export function num(v, name, { optional = false, min, max, gt, integer = false, def } = {}) {
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    if (optional) return undefined;
    throw new ValidationError(`${name} is required`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(`${name} must be a finite number`);
  if (integer && !Number.isInteger(v)) throw new ValidationError(`${name} must be an integer`);
  if (min !== undefined && v < min) throw new ValidationError(`${name} must be >= ${min}`);
  if (gt !== undefined && v <= gt) throw new ValidationError(`${name} must be > ${gt}`);
  if (max !== undefined && v > max) throw new ValidationError(`${name} must be <= ${max}`);
  return v;
}

export function oneOf(v, name, allowed, { optional = false, def } = {}) {
  if (v === undefined || v === null) {
    if (def !== undefined) return def;
    if (optional) return undefined;
    throw new ValidationError(`${name} is required`);
  }
  if (!allowed.includes(v)) throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

export function isoDate(v, name, { optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw new ValidationError(`${name} is required`);
  }
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw new ValidationError(`${name} must be an ISO-8601 date`);
  return d.toISOString();
}

export function plainObject(v, name, { optional = true } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new ValidationError(`${name} is required`);
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError(`${name} must be an object`);
  return v;
}

export function array(v, name, { min = 0 } = {}) {
  if (!Array.isArray(v)) throw new ValidationError(`${name} must be an array`);
  if (v.length < min) throw new ValidationError(`${name} must contain at least ${min} item(s)`);
  return v;
}

export const round = (n, dp = 6) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;
export const money = (n) => round(n, 4);
