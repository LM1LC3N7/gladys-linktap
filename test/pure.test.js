// -----------------------------------------------------------------------------
// Pure pieces: answers, configuration, /data, the lane's order.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from './kit/index.mjs';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { GatewayLane, PRIORITY } from '../src/linktap/lane.js';
import { configOf, num, parseAnswer, statusOf } from '../src/linktap/parse.js';
import { FileStore, emptyData, sanitize } from '../src/store.js';
import { GW, TAP1, TAP2 } from './helpers/gateway.js';

test('answers: raw JSON, HTML-wrapped, garbage', () => {
  assert.deepEqual(parseAnswer(Buffer.from('{"ret":0}'), 'application/json'), { ret: 0 });
  assert.deepEqual(
    parseAnswer(Buffer.from('<html><body>api{"ret":0,"gw_id":"X"}api</body></html>'), 'text/html'),
    {
      ret: 0,
      gw_id: 'X',
    },
  );
  assert.throws(() => parseAnswer(Buffer.from('<html>nothing</html>'), 'text/html'), {
    kind: 'invalid',
  });
  assert.throws(() => parseAnswer(Buffer.from('[1,2]'), 'application/json'), { kind: 'invalid' });
  // No prototype pollution: an own __proto__ key is just data.
  const value = parseAnswer(
    Buffer.from('{"__proto__":{"polluted":1},"ret":0}'),
    'application/json',
  );
  assert.equal({}.polluted, undefined);
  assert.equal(value.ret, 0);
});

test('strict numbers: empty or text is unknown, never 0', () => {
  assert.equal(num(''), undefined);
  assert.equal(num(null), undefined);
  assert.equal(num('Aus'), undefined);
  assert.equal(num(' 12.5 '), 12.5);
  assert.equal(num(Number.NaN), undefined);
});

test('cmd 16: ids checked, names cleaned, bounded', () => {
  const config = configOf({
    gw_id: GW.toLowerCase(),
    ver: 'G0608',
    vol_unit: 'gal',
    end_dev: [TAP1, 'bad:id', TAP2, TAP1, '../x'],
    dev_name: ['Potager\u0007', 'x', 'Pelouse'],
  });
  assert.equal(config.gatewayId, GW);
  assert.equal(config.volumeUnit, 'gal');
  assert.deepEqual(config.timers, [
    { id: TAP1, name: 'Potager' },
    { id: TAP2, name: 'Pelouse' },
  ]);
});

test('cmd 3: flat, dev_stat object or array, the right timer only', () => {
  const entry = {
    dev_id: TAP1,
    is_watering: true,
    remain_duration: 120,
    battery: 50,
    is_rf_linked: true,
  };
  assert.equal(statusOf({ ...entry }, TAP1, 'L').remaining, 120);
  assert.equal(statusOf({ dev_stat: entry }, TAP1, 'L').watering, true);
  assert.equal(statusOf({ dev_stat: [{ ...entry, dev_id: TAP2 }, entry] }, TAP1, 'L').battery, 50);
  assert.equal(statusOf({ dev_stat: [{ ...entry, dev_id: TAP2 }] }, TAP1, 'L'), undefined);
  assert.equal(statusOf({ ...entry, is_watering: 'yes' }, TAP1, 'L'), undefined);
  // Out of range: unknown.
  assert.equal(statusOf({ ...entry, battery: 101 }, TAP1, 'L').battery, undefined);
  // Not watering: nothing left.
  assert.equal(statusOf({ ...entry, is_watering: false }, TAP1, 'L').remaining, 0);
  // A flow without a known unit is never published.
  assert.equal(
    statusOf({ ...entry, is_flm_plugin: true, speed: 10 }, TAP1, undefined).flow,
    undefined,
  );
  assert.equal(statusOf({ ...entry, is_flm_plugin: true, speed: 10 }, TAP1, 'L').flow, 0.6);
});

test('the address: host or IPv4 and a port; no credentials, broadcast, multicast', () => {
  assert.deepEqual(parseAddress('http://192.168.1.30/'), { host: '192.168.1.30', port: 80 });
  assert.deepEqual(parseAddress('gw.local:8080'), { host: 'gw.local', port: 8080 });
  for (const bad of [
    'user:pw@192.168.1.3',
    '0.0.0.0',
    '224.0.0.1',
    '192.168.1.255',
    '255.255.255.255',
    'a b',
    '1.2.3',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const config = normalizeConfig({
    address: '192.168.1.30',
    watering_minutes: 9999,
    allow_watering: 'yes',
  });
  assert.equal(config.wateringMinutes, 120);
  assert.equal(config.allowWatering, false);
  assert.equal(normalizeConfig({ watering_minutes: '' }).wateringMinutes, 15);
});

test('/data: future times invalid, pause bounded, unknown keys dropped', () => {
  const now = Date.UTC(2026, 5, 1);
  const data = sanitize(
    {
      lastTry: now + 60_000,
      pause: { address: '192.168.1.5', until: now + 365 * 24 * 3600_000, failures: 3 },
      gateways: {
        [GW]: { id: GW, address: '192.168.1.5', timers: [{ id: TAP1, name: 'x' }], evil: 1 },
      },
      guards: {
        [TAP1]: {
          gatewayId: GW,
          stop: { at: now + 1e9, acked: true, resends: 99 },
          start: { at: now + 5, until: now + 1e9 },
        },
      },
    },
    now,
  );
  assert.equal(data.lastTry, undefined);
  assert.equal(data.pause.until, now + TIMINGS.pauseMax);
  assert.equal(data.gateways[GW].evil, undefined);
  assert.equal(data.guards[TAP1].stop.at, now);
  assert.equal(data.guards[TAP1].stop.resends, TIMINGS.stopResends);
  assert.deepEqual(data.guards[TAP1].start, { at: now, until: now + TIMINGS.startGuard });
});

test('FileStore: a missing file is empty, an unreadable one is "broken", never overwritten', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'linktap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore({ dir });
  assert.deepEqual(await store.load(), { data: emptyData(), broken: false });
  await writeFile(join(dir, 'linktap.json'), '{ not json');
  assert.equal((await store.load()).broken, true);
  await rm(join(dir, 'linktap.json'));
  await mkdir(join(dir, 'linktap.json'));
  assert.equal((await store.load()).broken, true);
  await rm(join(dir, 'linktap.json'), { recursive: true });
  const data = { ...emptyData(), lastTry: Date.now() - 1000 };
  await store.save(data);
  assert.equal((await store.load()).data.lastTry, data.lastTry);
});

test('the lane: one at a time, stops ahead of the queue, a cancelled request leaves unsent', async () => {
  const clock = testClock();
  const lane = new GatewayLane({
    monotonic: clock.monotonic,
    timers: clock.timers,
    stallCut: 1000,
    protectiveWait: 1500,
  });
  const order = [];
  const task = (name, ms) => () =>
    new Promise((resolve) => {
      order.push(name);
      clock.timers.setTimeout(resolve, ms);
    });
  const a = lane.run(task('read1', 100), { priority: PRIORITY.READ });
  const b = lane.run(task('read2', 100), { priority: PRIORITY.READ });
  const abort = new AbortController();
  const c = lane.run(task('start', 100), { priority: PRIORITY.COMMAND, signal: abort.signal });
  const d = lane.run(task('stop', 100), { priority: PRIORITY.PROTECTIVE });
  abort.abort();
  await assert.rejects(c, { kind: 'cancelled' });
  await clock.advance(1000);
  await Promise.all([a, b, d]);
  assert.deepEqual(order, ['read1', 'stop', 'read2']);
  assert.equal(lane.peak, 1);
});
