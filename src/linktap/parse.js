// -----------------------------------------------------------------------------
// Gateway answers -> plain values (pure). Field names from the LinkTap local
// HTTP API as used by linktap_local_http_component 0.8.9 (MIT) and described
// by the LinkTap protocol (the frames of the openHAB binding, read for the
// facts only):
//   cmd 16  { gw_id, ver, vol_unit: 'L' | 'gal', end_dev: [id], dev_name: [name] }
//   cmd 3   { gw_id, dev_id?, is_rf_linked, is_flm_plugin, is_fall, is_broken,
//             is_cutoff, is_leak, is_clog, signal, battery, is_manual_mode,
//             is_watering, is_paused, total_duration, remain_duration,
//             speed, volume, ... } flat, or under `dev_stat` (an object or
//             an array of them, one per timer)
// Strict: a boolean is `true` or `false` only, a number a finite number (a
// numeric text is taken, an empty one is unknown, never 0); a value outside
// its plausible range is unknown, never published.
// -----------------------------------------------------------------------------

import { LIMITS, LITRES_PER_GALLON } from '../constants.js';
import { LinkTapError } from './errors.js';

/** A gateway or water timer id: 16 letters or digits at most, `_<n>` for a sub-device. */
export const ID = /^[A-Za-z0-9]{1,16}(?:_[0-9])?$/;
export const GATEWAY_ID = /^[A-Za-z0-9]{1,16}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

/**
 * The JSON of an answer: raw (`application/json`, current firmwares) or
 * wrapped in a small HTML page (older ones: `<html>…api{…}api…</html>`). The
 * JSON object is taken from the first `{` to the last `}` (one linear scan).
 */
export function parseAnswer(body, contentType = '') {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  let json = text.trim();
  if (!/application\/json/i.test(String(contentType))) {
    const first = json.indexOf('{');
    const last = json.lastIndexOf('}');
    if (first < 0 || last <= first) {
      throw new LinkTapError('invalid', { sent: true });
    }
    json = json.slice(first, last + 1);
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new LinkTapError('invalid', { sent: true });
  }
  if (!isObject(value)) {
    throw new LinkTapError('invalid', { sent: true });
  }
  return value;
}

/** A text read from a gateway, without control characters, trimmed and cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/** An id as kept: upper case, checked. */
export function idOf(value, pattern = ID) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const id = value.trim().toUpperCase();
  return pattern.test(id) ? id : undefined;
}

/** A strict boolean: only true or false. */
const bool = (value) => (value === true || value === false ? value : undefined);

/** A strict number: a finite number or its exact text; '' and null are unknown, never 0. */
export function num(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,9}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const within = (value, min, max) =>
  value !== undefined && value >= min && value <= max ? value : undefined;
const integer = (value, min, max) =>
  Number.isInteger(value) ? within(value, min, max) : undefined;

/** The gateway id of any answer (cmd 3 without ids answers with it). */
export const gatewayIdOf = (json) => idOf(own(json, 'gw_id'), GATEWAY_ID);

/** The unit of the volumes: 'L', 'gal' or undefined (then no volume nor flow is published). */
export function volumeUnitOf(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const unit = value.trim().toLowerCase();
  return unit === 'l' ? 'L' : unit === 'gal' ? 'gal' : undefined;
}

/** cmd 16: the gateway, its firmware, unit and water timers (ids and names). */
export function configOf(json) {
  const gatewayId = gatewayIdOf(json);
  const ids = own(json, 'end_dev');
  const names = own(json, 'dev_name');
  let timers;
  if (Array.isArray(ids)) {
    timers = [];
    for (const [index, raw] of ids.slice(0, LIMITS.timers).entries()) {
      const id = idOf(raw);
      if (!id || timers.some((t) => t.id === id)) {
        continue;
      }
      const name = Array.isArray(names) ? cleanText(names[index], 64) : '';
      timers.push({ id, name });
    }
  }
  return {
    gatewayId,
    version: cleanText(own(json, 'ver'), 32),
    volumeUnit: volumeUnitOf(own(json, 'vol_unit')),
    timers,
  };
}

/** The status object of one timer in a cmd 3 answer, or undefined. */
export function statusEntryOf(json, timerId) {
  const stat = own(json, 'dev_stat');
  const entries = Array.isArray(stat)
    ? stat.slice(0, LIMITS.timers)
    : isObject(stat)
      ? [stat]
      : [json];
  const matches = entries.filter((entry) => {
    if (!isObject(entry)) {
      return false;
    }
    const id = own(entry, 'dev_id');
    // A flat answer may omit the id; a given id must be this timer.
    return id === undefined ? entries.length === 1 : idOf(id) === timerId;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

const toLitres = (value, unit) =>
  value === undefined || unit === undefined
    ? undefined
    : unit === 'gal'
      ? value * LITRES_PER_GALLON
      : value;

/**
 * cmd 3 -> the values of a timer. `watering` is required (undefined: the
 * answer is unreadable). Values in litres and m³/h; `flow` and `volume` only
 * with a flow meter and a known unit.
 */
export function statusOf(json, timerId, volumeUnit) {
  const entry = statusEntryOf(json, timerId);
  if (!entry) {
    return undefined;
  }
  const watering = bool(own(entry, 'is_watering'));
  if (watering === undefined) {
    return undefined;
  }
  const flowMeter = bool(own(entry, 'is_flm_plugin'));
  const litresPerMinute = within(
    toLitres(num(own(entry, 'speed')), volumeUnit),
    0,
    LIMITS.flowLitresPerMinute,
  );
  const litres = within(toLitres(num(own(entry, 'volume')), volumeUnit), 0, LIMITS.sessionLitres);
  const remaining = integer(num(own(entry, 'remain_duration')), 0, LIMITS.remainingSeconds);
  return {
    watering,
    rfLinked: bool(own(entry, 'is_rf_linked')),
    paused: bool(own(entry, 'is_paused')),
    manual: bool(own(entry, 'is_manual_mode')),
    flowMeter,
    battery: integer(num(own(entry, 'battery')), 0, 100),
    signal: integer(num(own(entry, 'signal')), 0, 100),
    // A remaining length is 0 once the watering ended (the gateway may keep the last one).
    remaining: watering ? remaining : 0,
    // The length of the current run: with `remaining`, it tells one run from the next.
    total: integer(num(own(entry, 'total_duration')), 0, LIMITS.remainingSeconds),
    flow:
      flowMeter === true && litresPerMinute !== undefined
        ? Math.round(litresPerMinute * 0.06 * 1000) / 1000
        : undefined,
    volume: flowMeter === true && litres !== undefined ? Math.round(litres * 10) / 10 : undefined,
    alerts: {
      high_flow: bool(own(entry, 'is_leak')),
      low_flow: bool(own(entry, 'is_clog')),
      water_cut: bool(own(entry, 'is_cutoff')),
      fall: bool(own(entry, 'is_fall')),
      valve_failure: bool(own(entry, 'is_broken')),
    },
  };
}
