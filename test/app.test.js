// -----------------------------------------------------------------------------
// The app end to end: the SDK's fake Gladys, a scripted gateway, a virtual
// clock that moves at every read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';
import { GW, OTHER_GW, TAP1, TAP2, gatewayBrain, raw } from './helpers/gateway.js';
import { ADDRESS, CONFIG, F, NOW, createdDevice, knownData, setup } from './helpers/app.js';

const SECOND = 1000;
const ack = (result) => result;

test('discovery: one device per water timer, buttons only, flow features with a flow meter', async () => {
  const { gladys, brain } = await setup({ created: [] });
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id).sort(),
    [`ext:linktap:linktap:${TAP1}`, `ext:linktap:linktap:${TAP2}`].sort(),
  );
  const tap2 = devices.find((d) => d.external_id.endsWith(TAP2));
  const keys = tap2.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys.includes('flow') && keys.includes('volume'));
  const tap1 = devices.find((d) => d.external_id.endsWith(TAP1));
  assert.ok(!tap1.features.some((f) => f.external_id.endsWith(':flow')));
  for (const feature of tap1.features) {
    assert.notEqual(feature.category, 'switch');
    if (!feature.read_only) assert.equal(feature.category, 'button');
  }
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(brain.count(16), 1);
});

test('reads never sooner than the interval, nor after a restart', async () => {
  const { app, clock, brain, store } = await setup();
  assert.equal(brain.count(16), 1);
  await clock.advance(29 * SECOND);
  assert.equal(brain.count(16), 1);
  await clock.advance(6 * SECOND);
  assert.equal(brain.count(16), 2);
  await app.stop();
  // A restart right after: no read before a whole interval.
  const again = await setup({
    store: new MemoryStore(store.data, { now: () => NOW + 40 * SECOND }),
  });
  assert.equal(again.brain.count(16), 0);
  await again.clock.advance(25 * SECOND);
  assert.equal(again.brain.count(16), 0);
  await again.clock.advance(10 * SECOND);
  assert.equal(again.brain.count(16), 1);
});

test('values: strict, converted, a timer not linked by radio only says so', async () => {
  const brain = gatewayBrain({ volUnit: 'gal' });
  brain.timer(TAP2).watering = true;
  brain.timer(TAP2).volume = 10;
  brain.timer(TAP1).rfLinked = false;
  const created = [
    { id: TAP1, name: 'Potager' },
    { id: TAP2, name: 'Pelouse', flowMeter: true },
  ];
  const { gladys, clock } = await setup({ brain, created });
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F(TAP2, 'volume')), 37.9);
  assert.equal(
    gladys.fake.lastState(F(TAP2, 'flow')),
    Math.round(12.5 * 3.785411784 * 0.06 * 1000) / 1000,
  );
  assert.equal(gladys.fake.lastState(F(TAP2, 'battery')), 87);
  assert.equal(gladys.fake.lastState(F(TAP1, 'rf_linked')), 0);
  assert.equal(gladys.fake.lastState(F(TAP1, 'battery')), undefined);
  assert.equal(gladys.fake.lastState(F(TAP1, 'watering')), undefined);
});

test('a text or an empty value is never published as 0', async () => {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  brain.answer = (p) =>
    p.cmd === 3 ? { ...answer(p), battery: '', signal: 'Aus', remain_duration: null } : answer(p);
  const { gladys, clock } = await setup({ brain, created: [{ id: TAP1, name: 'Potager' }] });
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.lastState(F(TAP1, 'battery')), undefined);
  assert.equal(gladys.fake.lastState(F(TAP1, 'signal')), undefined);
  assert.equal(gladys.fake.lastState(F(TAP1, 'watering')), 0);
});

test('start is off by default: refused, nothing sent', async () => {
  const { brain, press } = await setup({
    config: { address: ADDRESS },
    created: [{ id: TAP1, name: 'P' }],
  });
  const result = await press(TAP1, 'start');
  assert.equal(result.success, false);
  assert.match(result.error, /désactivé/);
  assert.equal(brain.count(6), 0);
});

test('start: bounded length, guard on disk before it leaves, confirmed by a read', async () => {
  const { brain, press, store, clock } = await setup({
    config: { ...CONFIG, watering_minutes: 500 },
    created: [{ id: TAP1, name: 'P' }],
  });
  const saves = store.saves;
  const result = await press(TAP1, 'start');
  assert.equal(result.success, true, result.error);
  assert.deepEqual(brain.timer(TAP1).starts, [120 * 60]);
  assert.ok(store.saves > saves);
  // A start not seen yet (slow radio): another one within the minute is refused at once.
  brain.timer(TAP1).watering = false;
  brain.radioMs = 2 * 60 * SECOND;
  brain.schedule = (fn, ms) => clock.timers.setTimeout(fn, ms);
  await clock.advance(31 * SECOND);
  const first = await press(TAP2, 'start');
  assert.match(first.error ?? '', /sans confirmation/);
  const again = await press(TAP2, 'start');
  assert.equal(again.success, false);
  assert.match(again.error, /vient de partir/);
  assert.equal(brain.count(6, TAP2), 1);
  // After the minute, allowed again.
  await clock.advance(61 * SECOND);
  await press(TAP2, 'start');
  assert.equal(brain.count(6, TAP2), 2);
});

test('start: /data not writable or unreadable refuses, nothing sent', async () => {
  const store = new MemoryStore(knownData(), { failSaves: true });
  const { brain, press } = await setup({ store, created: [{ id: TAP1, name: 'P' }] });
  const result = await press(TAP1, 'start');
  assert.equal(result.success, false);
  assert.equal(brain.count(6), 0);
  const broken = await setup({ store: new MemoryStore(knownData(), { broken: true }) });
  const refused = await broken.press(TAP1, 'start');
  assert.equal(refused.success, false);
  // The stop still goes.
  const stopped = await broken.press(TAP1, 'stop');
  assert.equal(stopped.success, true, stopped.error);
  assert.equal(broken.brain.count(7, TAP1), 1);
});

test('start: refused by the gateway (ret 7) lifts its guard; unconfirmed says so', async () => {
  const { brain, press, clock } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 6 ? { cmd: 6, gw_id: GW, dev_id: TAP1, ret: 7 } : answer(p));
  const result = await press(TAP1, 'start');
  assert.equal(result.success, false);
  assert.match(result.error, /Refusé par la passerelle/);
  brain.answer = answer;
  // The radio is slow: sent, without confirmation.
  brain.radioMs = 10 * SECOND;
  brain.schedule = (fn, ms) => clock.timers.setTimeout(fn, ms);
  const slow = await press(TAP1, 'start');
  assert.equal(slow.success, false);
  assert.match(slow.error, /Envoyé, sans confirmation/);
  assert.deepEqual(brain.timer(TAP1).starts, [900]);
});

test('stop: never held by the option, a pause, a missing configuration', async () => {
  const { brain, press, app, clock } = await setup({
    config: { address: ADDRESS },
    created: [{ id: TAP1, name: 'P' }],
  });
  brain.timer(TAP1).watering = true;
  // A 503 pauses the reads.
  brain.next.push(raw(503));
  await clock.advance(31 * SECOND);
  assert.ok(app.paused());
  const result = await press(TAP1, 'stop');
  // No confirmation read during the pause: sent, taken, not read back.
  assert.match(result.error ?? 'ok', /ok|sans confirmation/);
  assert.equal(brain.count(7, TAP1), 1);
  assert.equal(brain.timer(TAP1).watering, false);
});

test('stop right after a restart, before getConfig answers', async () => {
  const data = knownData();
  const { brain, press, gladys } = await setup({
    data,
    failConfig: 1000,
    created: [{ id: TAP1, name: 'P' }],
    start: false,
  });
  brain.timer(TAP1).watering = true;
  const result = await press(TAP1, 'stop');
  assert.equal(result.success, true, result.error);
  assert.equal(brain.count(7, TAP1), 1);
  assert.equal(brain.count(16), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration could not be read/);
});

test('a stop not taken before a restart leaves at boot, from /data only', async () => {
  const data = knownData({
    guards: {
      [TAP1]: { gatewayId: GW, stop: { at: NOW - 5000, acked: false, dry: false, resends: 0 } },
    },
  });
  const { app, brain, drive, clock } = await setup({ data, connect: false });
  await drive(app.boot());
  await clock.advance(100);
  assert.equal(brain.count(7, TAP1), 1);
  assert.equal(app.data.guards[TAP1].stop.acked, true);
  assert.equal(app.data.guards[TAP1].stop.resends, 0, 'a stop not taken yet is never counted');
});

test('getConfig failing in "connected": tried again without end, then the integration starts', async () => {
  const { app, gladys, clock, configCalls } = await setup({ failConfig: 3, start: false });
  assert.match(gladys.fake.connectionStatus.message.fr, /configuration n'a pas pu être lue/);
  await clock.advance(60 * SECOND);
  await app.applying;
  assert.ok(configCalls() >= 4);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a stop cuts a silent read and leaves within its deadline; one request at a time', async () => {
  const { brain, press, net, clock, app } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.timer(TAP1).watering = true;
  brain.next.push('silent');
  await clock.advance(31 * SECOND);
  assert.ok(app.reading, 'a read is hanging');
  const started = clock.monotonic();
  const result = await press(TAP1, 'stop');
  assert.ok(brain.count(7, TAP1) === 1);
  assert.equal(net.peak, 1);
  assert.equal(result.success, true, result.error);
  assert.ok(clock.monotonic() - started < 5000);
});

test('a stop cancels the start queued for its timer: nothing emitted before the stop leaves after it', async () => {
  const { brain, net, gladys, clock, drive } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  net.latencyMs = (p) => (p.cmd === 16 ? 2000 : 0);
  await clock.advance(30 * SECOND);
  const device = createdDevice(gladys);
  const start = gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === F(TAP1, 'start')),
    1,
  );
  await clock.advance(100);
  const stop = gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === F(TAP1, 'stop')),
    1,
  );
  const [started, stopped] = await drive(Promise.all([start, stop]));
  assert.equal(started.success, false);
  assert.match(started.error, /Annulé par un arrêt/);
  assert.equal(stopped.success, true, stopped.error);
  assert.equal(brain.count(6), 0);
  assert.equal(brain.count(7, TAP1), 1);
});

test('a stop the timer ignores is sent again by the reads, 3 times at most', async () => {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  // The gateway takes the stop, the timer keeps watering.
  brain.answer = (p) => (p.cmd === 7 ? { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 0 } : answer(p));
  brain.timer(TAP1).watering = true;
  const { press, clock, store, gladys } = await setup({
    brain,
    created: [{ id: TAP1, name: 'P' }],
  });
  const result = await press(TAP1, 'stop');
  assert.equal(result.success, false);
  await clock.advance(10 * 60 * SECOND);
  assert.equal(brain.count(7, TAP1), 4);
  assert.equal(store.data.guards[TAP1].stop.resends, 3);
  assert.match(gladys.fake.connectionStatus.message.en, /Still watering after a stop/);
});

test('the stop guard: dry, then a watering started elsewhere read twice in a row lifts it; never by time', async () => {
  const { brain, press, clock, store } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.timer(TAP1).watering = true;
  await press(TAP1, 'stop');
  await clock.advance(5 * 60 * SECOND);
  assert.equal(store.data.guards[TAP1].stop.dry, true);
  await clock.advance(24 * 60 * 60 * SECOND);
  assert.ok(store.data.guards[TAP1]?.stop, 'never lifted by the time');
  brain.timer(TAP1).watering = true;
  await clock.advance(31 * SECOND);
  assert.ok(store.data.guards[TAP1]?.stop);
  assert.equal(brain.count(7, TAP1), 1, 'no resend once dry');
  await clock.advance(31 * SECOND);
  assert.equal(store.data.guards[TAP1]?.stop, undefined);
});

test('a start from Gladys that leaves lifts the stop guard', async () => {
  const { brain, press, clock, store } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.timer(TAP1).watering = true;
  await press(TAP1, 'stop');
  assert.ok(store.data.guards[TAP1].stop);
  await clock.advance(SECOND);
  const result = await press(TAP1, 'start');
  assert.equal(result.success, true, result.error);
  await clock.advance(5 * 60 * SECOND);
  assert.equal(brain.count(7, TAP1), 1, 'the stop is not sent again over the newer start');
  assert.equal(brain.timer(TAP1).watering, true);
});

test('a scene starting 5 slow timers starts them all, one request at a time', async () => {
  const ids = [
    'A0000000000000A1',
    'A0000000000000A2',
    'A0000000000000A3',
    'A0000000000000A4',
    'A0000000000000A5',
  ];
  const brain = gatewayBrain({ timers: ids.map((id, i) => ({ id, name: `Zone ${i}` })) });
  const { gladys, net, drive, clock } = await setup({
    brain,
    created: ids.map((id) => ({ id, name: id })),
  });
  net.latencyMs = 800;
  const presses = ids.map((id) => {
    const device = createdDevice(gladys, { id, name: id });
    return gladys.fake.setValue(
      device,
      device.features.find((f) => f.external_id === F(id, 'start')),
      1,
    );
  });
  await drive(Promise.all(presses));
  await clock.advance(10 * SECOND);
  for (const id of ids) {
    assert.equal(brain.timer(id).starts.length, 1, id);
  }
  assert.equal(net.peak, 1);
});

test('a failing timer does not stop the others', async () => {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  brain.answer = (p) =>
    p.cmd === 3 && p.dev_id === TAP1 ? { cmd: 3, gw_id: GW, ret: 6 - 1 } : answer(p);
  const { gladys, clock } = await setup({
    brain,
    created: [
      { id: TAP1, name: 'P' },
      { id: TAP2, name: 'L', flowMeter: true },
    ],
  });
  await clock.advance(SECOND);
  assert.equal(gladys.fake.lastState(F(TAP2, 'watering')), 0);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /1 water timer\(s\) not read/);
});

test('another gateway at the address: identified as moved, starts of the old one refused', async () => {
  const { brain, press, clock, gladys } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.id = OTHER_GW;
  await clock.advance(31 * SECOND);
  assert.match(gladys.fake.connectionStatus.message.en, /no longer answers/);
  const result = await press(TAP1, 'start');
  assert.equal(result.success, false);
  assert.equal(brain.count(6), 0);
});

test('pause of the plan: decided on a read, never a second pause', async () => {
  const { brain, press } = await setup({
    config: { address: ADDRESS },
    created: [{ id: TAP1, name: 'P' }],
  });
  const result = await press(TAP1, 'pause_plan');
  assert.equal(result.success, true, result.error);
  assert.deepEqual(brain.timer(TAP1).pauses, [24]);
  const again = await press(TAP1, 'pause_plan');
  assert.equal(again.success, true);
  assert.deepEqual(brain.timer(TAP1).pauses, [24]);
  assert.notEqual(brain.timer(TAP1).planOff, true);
});

test('configurations saved in a row apply one at a time, the last one wins', async () => {
  const { app, gladys, drive } = await setup();
  const a = gladys.fake.configUpdated({ ...CONFIG, poll_interval: 60 });
  const b = gladys.fake.configUpdated({ ...CONFIG, poll_interval: 90 });
  const c = gladys.fake.configUpdated({ ...CONFIG, poll_interval: 120 });
  await drive(Promise.all([a, b, c]));
  await drive(app.applying ?? Promise.resolve());
  assert.equal(app.config.pollInterval, 120);
});

test('nothing old is published as new when a device is created later', async () => {
  const { app, gladys, clock } = await setup();
  await clock.advance(SECOND);
  const before = gladys.fake.states.length;
  // The gateway goes away: the last values grow old.
  app.client.request = () => Promise.reject(Object.assign(new Error('x'), { kind: 'unreachable' }));
  await clock.advance(10 * 60 * SECOND);
  await gladys.fake.deviceCreated(createdDevice(gladys));
  await clock.advance(2 * SECOND);
  assert.equal(gladys.fake.states.length, before);
  ack();
});

test('start: decided on a read just now; already watering or not linked: nothing sent', async () => {
  const { brain, press } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.timer(TAP1).watering = true;
  const already = await press(TAP1, 'start');
  assert.equal(already.success, true, already.error);
  assert.equal(brain.count(6), 0);
  brain.timer(TAP1).watering = false;
  brain.timer(TAP1).rfLinked = false;
  const unlinked = await press(TAP1, 'start');
  assert.equal(unlinked.success, false);
  assert.match(unlinked.error, /n'a pas pu être lu/);
  assert.equal(brain.count(6), 0);
  // The option is checked again right before the request leaves.
  brain.timer(TAP1).rfLinked = true;
});

test('start: the option switched off while it waits: nothing sent', async () => {
  const { brain, gladys, net, clock, drive, app } = await setup({
    created: [{ id: TAP1, name: 'P' }],
  });
  net.latencyMs = 1000;
  const device = createdDevice(gladys);
  const pressed = gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === F(TAP1, 'start')),
    1,
  );
  await clock.advance(500);
  app.latest.allowWatering = false;
  const result = await drive(pressed);
  assert.equal(result.success, false);
  assert.equal(brain.count(6), 0);
});

test('start: the option is checked again right before the request leaves', async () => {
  const { brain, net, press, clock, app } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => {
    if (p.cmd === 3 && p.dev_id === TAP1) {
      // The start connects slowly; the option goes off meanwhile.
      net.connectMs = 500;
      clock.timers.setTimeout(() => {
        app.latest.allowWatering = false;
      }, 200);
    }
    return answer(p);
  };
  const result = await press(TAP1, 'start');
  assert.equal(result.success, false);
  assert.match(result.error, /désactivé/);
  assert.equal(brain.count(6), 0);
});

test('start: an unreadable /data says so; the length is capped in the code too', async () => {
  const broken = await setup({ store: new MemoryStore(knownData(), { broken: true }) });
  const refused = await broken.press(TAP1, 'start');
  assert.match(refused.error, /illisible/);
  const { brain, press, app } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  app.latest.wateringMinutes = 100_000;
  await press(TAP1, 'start');
  assert.deepEqual(brain.timer(TAP1).starts, [120 * 60]);
});

test('a stop drops the start waiting in the queue at once', async () => {
  const { gladys, net, clock, app } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  net.latencyMs = (p) => (p.cmd === 16 ? 2000 : 0);
  await clock.advance(30 * SECOND);
  const device = createdDevice(gladys);
  const feature = (key) => device.features.find((f) => f.external_id === F(TAP1, key));
  const start = gladys.fake.setValue(device, feature('start'), 1);
  await clock.advance(100);
  const lane = app.lanes.get(ADDRESS);
  assert.ok(
    lane.queue.some((e) => e.priority === 2),
    'the start waits',
  );
  gladys.fake.setValue(device, feature('stop'), 1);
  await clock.advance(10);
  assert.ok(!lane.queue.some((e) => e.priority === 2), 'dropped at once');
  await clock.advance(10 * SECOND);
  await start;
});

test('a start that leaves lifts the stop guard at once', async () => {
  const { brain, press, clock, app } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.timer(TAP1).watering = true;
  await press(TAP1, 'stop');
  assert.equal(app.data.guards[TAP1].stop.dry, true);
  await clock.advance(SECOND);
  await press(TAP1, 'start');
  assert.equal(app.data.guards[TAP1]?.stop, undefined);
});

test('a start of a timer still watering after a stop lifts the stop guard: no resend over it', async () => {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 7 ? { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 0 } : answer(p));
  brain.timer(TAP1).watering = true;
  const { press, clock } = await setup({ brain, created: [{ id: TAP1, name: 'P' }] });
  await press(TAP1, 'stop');
  const started = await press(TAP1, 'start');
  assert.equal(started.success, true, started.error);
  await clock.advance(5 * 60 * SECOND);
  assert.equal(brain.count(7, TAP1), 1);
});

test('a stop taken by the gateway is not resent while the radio carries it', async () => {
  const { brain, press, clock } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.timer(TAP1).watering = true;
  brain.radioMs = 2500;
  brain.schedule = (fn, ms) => clock.timers.setTimeout(fn, ms);
  await press(TAP1, 'stop');
  await clock.advance(3 * SECOND);
  assert.equal(brain.count(7, TAP1), 1);
  assert.equal(brain.timer(TAP1).watering, false);
});

test('a stop that could not connect is tried again 250 ms later, within its deadline', async () => {
  const { brain, net, press, clock } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  brain.timer(TAP1).watering = true;
  net.down = true;
  clock.timers.setTimeout(() => {
    net.down = false;
  }, 100);
  const result = await press(TAP1, 'stop');
  assert.equal(brain.count(7, TAP1), 1, result.error);
  assert.equal(brain.timer(TAP1).watering, false);
});

test('cmd 16 failing never stops the reads of the known timers', async () => {
  const { brain, gladys, clock } = await setup({ created: [{ id: TAP1, name: 'P' }] });
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 16 ? { cmd: 16, gw_id: GW, ret: 2 } : answer(p));
  brain.timer(TAP1).watering = true;
  await clock.advance(31 * SECOND);
  assert.equal(gladys.fake.lastState(F(TAP1, 'watering')), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
