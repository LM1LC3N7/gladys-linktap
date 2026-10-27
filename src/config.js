// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The local API of
// the gateway has no secret: nothing here is one.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, PAUSE_HOURS, POLL_INTERVAL, WATERING_MINUTES } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  allow_watering: false,
  watering_minutes: WATERING_MINUTES.default,
  pause_hours: PAUSE_HOURS.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

/** An IPv4 address the gateway can have: no 0.x, multicast, reserved nor x.x.x.255 broadcast. */
function usableIpv4(host) {
  const parts = host.split('.').map(Number);
  return !(parts[0] === 0 || parts[0] >= 224 || parts[3] === 255);
}

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port (80 by default). A pasted URL ("http://192.168.1.30/") is
 * reduced to its host and port; credentials in it are refused.
 * @returns {{ host: string, port: number } | undefined}
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  text = text.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  if (text.includes('@')) {
    return undefined;
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (host.length > 253 || port < 1 || port > 65535) {
    return undefined;
  }
  const valid = IPV4.test(host)
    ? usableIpv4(host)
    : !/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l));
  return valid ? { host, port } : undefined;
}

/** An address as kept (`host` or `host:port`), for /data and the comparisons. */
export const addressKey = (address) =>
  address ? (address.port === DEFAULT_PORT ? address.host : `${address.host}:${address.port}`) : '';

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed);
  return {
    /** { host, port } or undefined. */
    address,
    key: addressKey(address),
    /** Shown in the status when it is not an address: cut at an '@' and a query. */
    invalidAddress:
      typed !== '' && !address
        ? typed
            .replace(/^.*@/, '…@')
            .replace(/[?#].*$/, '…')
            .slice(0, 60)
        : undefined,
    allowWatering: strictTrue(c.allow_watering),
    wateringMinutes: bounded(c.watering_minutes, WATERING_MINUTES),
    pauseHours: bounded(c.pause_hours, PAUSE_HOURS),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}
