// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume):
//   - the known gateways (by id): their address, firmware, volume unit and
//     water timers, so watering can be stopped after a restart before any
//     read or configuration, and a created device never loses a feature;
//   - the pause asked by the gateway (429, 5xx, busy);
//   - the guards of each water timer: the last start (a minute) and the last
//     stop, kept until a read shows the timer dry, a newer start from Gladys
//     leaves, or a watering started elsewhere is read twice in a row: never
//     lifted by the time alone;
//   - the time of the last read (written at most once a minute), so a restart
//     never reads sooner than the interval, and its outcome (the status until
//     the first read).
// A file that exists but cannot be read is never taken for an empty one: the
// app then runs without writing (nothing overwritten), starts refused.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAddress, addressKey } from './config.js';
import { LIMITS, TIMINGS } from './constants.js';
import { GATEWAY_ID, ID, cleanText, volumeUnitOf } from './linktap/parse.js';

export const emptyData = () => ({
  lastTry: undefined,
  lastRead: undefined,
  gateways: {},
  pause: undefined,
  guards: {},
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const failuresOf = (value) => (Number.isInteger(value) ? Math.min(Math.max(value, 1), 100) : 1);
const countOf = (value, max) => (Number.isInteger(value) ? Math.min(Math.max(value, 0), max) : 0);
/** An address as kept, checked (`host` or `host:port`). */
const addressOf = (value) =>
  typeof value === 'string' && addressKey(parseAddress(value)) === value ? value : undefined;

function timersOf(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const timers = [];
  for (const timer of list.slice(0, LIMITS.timers)) {
    if (
      !isObject(timer) ||
      !ID.test(String(timer.id ?? '')) ||
      timers.some((t) => t.id === timer.id)
    ) {
      continue;
    }
    timers.push({
      id: timer.id,
      name: cleanText(timer.name, 64),
      ...(timer.flowMeter === true ? { flowMeter: true } : {}),
    });
  }
  return timers;
}

function stopGuardOf(guard, now) {
  if (!isObject(guard)) {
    return undefined;
  }
  return {
    // Unknown or in the future (a clock that went back, a file edited): now.
    at: Number.isFinite(guard.at) && guard.at <= now ? guard.at : now,
    acked: guard.acked === true,
    dry: guard.dry === true,
    resends: countOf(guard.resends, TIMINGS.stopResends),
    seenWatering: countOf(guard.seenWatering, 2),
  };
}

/** A start or pause guard: `{ at, until }`, never longer than `longest` from its time. */
function startGuardOf(guard, now, longest) {
  if (!isObject(guard) || !Number.isFinite(guard.at)) {
    return undefined;
  }
  // Dated in the future (a clock that went back): kept from now, the safe side.
  const at = Math.min(guard.at, now);
  const until = Number.isFinite(guard.until) ? Math.min(guard.until, at + longest) : at + longest;
  return until > now ? { at, until } : undefined;
}

/**
 * What a file holds, checked: unknown keys dropped, ids and addresses checked,
 * every time in the future taken as invalid, every end of a pause never later
 * than its longest bound from now.
 */
export function sanitize(data, now) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (Number.isFinite(data.lastTry) && data.lastTry <= now) {
    base.lastTry = data.lastTry;
  }
  if (isObject(data.lastRead) && typeof data.lastRead.ok === 'boolean') {
    const address = addressOf(data.lastRead.address);
    const at =
      Number.isFinite(data.lastRead.at) && data.lastRead.at <= now ? data.lastRead.at : undefined;
    if (address && at !== undefined) {
      const id = String(data.lastRead.gatewayId ?? '');
      base.lastRead =
        data.lastRead.ok && GATEWAY_ID.test(id)
          ? { ok: true, gatewayId: id, address, at }
          : { ok: false, address, at };
    }
  }
  if (isObject(data.gateways)) {
    for (const [id, record] of Object.entries(data.gateways).slice(0, LIMITS.gateways)) {
      if (!GATEWAY_ID.test(id) || !isObject(record) || record.id !== id) {
        continue;
      }
      base.gateways[id] = {
        id,
        address: record.address === '' ? '' : (addressOf(record.address) ?? ''),
        version: cleanText(record.version, 32),
        volumeUnit: volumeUnitOf(record.volumeUnit),
        timers: timersOf(record.timers),
      };
      if (base.gateways[id].volumeUnit === undefined) {
        delete base.gateways[id].volumeUnit;
      }
    }
  }
  if (isObject(data.pause) && addressOf(data.pause.address)) {
    const until = Number.isFinite(data.pause.until)
      ? Math.min(data.pause.until, now + TIMINGS.pauseMax)
      : now;
    if (until > now) {
      base.pause = {
        address: data.pause.address,
        until,
        failures: failuresOf(data.pause.failures),
      };
    }
  }
  if (isObject(data.guards)) {
    for (const [id, guards] of Object.entries(data.guards).slice(
      0,
      LIMITS.timers * LIMITS.gateways,
    )) {
      if (!ID.test(id) || !isObject(guards) || !GATEWAY_ID.test(String(guards.gatewayId ?? ''))) {
        continue;
      }
      const start = startGuardOf(guards.start, now, TIMINGS.startGuard);
      const pause = startGuardOf(guards.pause, now, TIMINGS.pauseGuard);
      const stop = stopGuardOf(guards.stop, now);
      if (start || stop || pause) {
        base.guards[id] = { gatewayId: guards.gatewayId };
        if (start) base.guards[id].start = start;
        if (pause) base.guards[id].pause = pause;
        if (stop) base.guards[id].stop = stop;
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({
    dir = process.env.DATA_DIR || '/data',
    name = 'linktap.json',
    now = Date.now,
  } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
  }

  /** `{ data, broken }`: `broken` when a file exists but cannot be read or parsed. */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      return { data: emptyData(), broken: err?.code !== 'ENOENT' };
    }
    try {
      return { data: sanitize(JSON.parse(text), this.now()), broken: false };
    } catch {
      return { data: emptyData(), broken: true };
    }
  }

  /** Writes the whole file (temporary file, then rename); rejects on a failure. */
  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(
    data = emptyData(),
    { now = Date.now, broken = false, failSaves = false, hangSaves = false } = {},
  ) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.now = now;
    this.broken = broken;
    this.failSaves = failSaves;
    this.hangSaves = hangSaves;
  }

  async load() {
    if (this.broken) {
      return { data: emptyData(), broken: true };
    }
    return { data: sanitize(JSON.parse(JSON.stringify(this.data)), this.now()), broken: false };
  }

  async save(data) {
    if (this.hangSaves) {
      // A disk that never answers.
      await new Promise(() => {});
    }
    if (this.failSaves) {
      throw new Error('disk full');
    }
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}
