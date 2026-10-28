// -----------------------------------------------------------------------------
// Review r2: a stop the gateway refuses (busy, 404) is retried, spaced and
// without end, never counted; a run of the same length started elsewhere is
// told from the stopped one on proof only (length, time left, age), else the
// stop wins.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';
import { GW, TAP1, gatewayBrain, raw } from './helpers/gateway.js';
import { NOW, knownData, setup } from './helpers/app.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const P = { id: TAP1, name: 'P' };
const cmd7 = (net) => net.payloads.filter((p) => p.cmd === 7).length;

/** The gateway answers `busy(p)` (when not undefined) instead of its answer. */
function busyBrain(busy) {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => busy(p) ?? answer(p);
  return brain;
}

for (const [mode, reply] of [
  ['HTTP 503', () => raw(503)],
  ['ret 8', (p) => ({ cmd: p.cmd, gw_id: GW, dev_id: p.dev_id, ret: 8 })],
]) {
  test(`B1: gateway busy (${mode}) for 60 s: the stop is never counted, and leaves once it is free`, async () => {
    let busy = false;
    const brain = busyBrain((p) => (busy ? reply(p) : undefined));
    brain.timer(TAP1).watering = true;
    const { net, press, clock, app, gladys } = await setup({ brain, created: [P] });
    busy = true;
    const ack = await press(TAP1, 'stop');
    assert.match(ack.error, /pas encore pris/);
    await clock.advance(60 * SECOND);
    assert.equal(app.data.guards[TAP1].stop.resends, 0);
    assert.ok(cmd7(net) <= 16, `no tight loop: ${cmd7(net)} stops in 60 s`);
    assert.match(gladys.fake.connectionStatus.message.en, /Stop not taken by the gateway yet/);
    busy = false;
    await clock.advance(11 * SECOND);
    assert.equal(brain.timer(TAP1).watering, false, 'taken as soon as the gateway is free');
    assert.equal(app.data.guards[TAP1].stop.acked, true);
  });
}

test('B1: a gateway answering 404 to every stop: retried without end, spaced, never counted', async () => {
  const brain = busyBrain((p) => (p.cmd === 7 ? raw(404) : undefined));
  brain.timer(TAP1).watering = true;
  const { net, press, clock, app } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  await clock.advance(5 * MINUTE);
  const firstFive = cmd7(net);
  assert.ok(firstFive <= 2 * 31 + 2, `every 10 s at most: ${firstFive}`);
  await clock.advance(10 * MINUTE);
  const next = cmd7(net) - firstFive;
  assert.ok(next >= 5 && next <= 2 * 11, `then every minute: ${next}`);
  assert.equal(app.data.guards[TAP1].stop.resends, 0);
  assert.equal(app.data.guards[TAP1].stop.acked, false);
});

test('B1: a resend counts once per call, its 250 ms retry included', async () => {
  let stops = 0;
  const brain = busyBrain((p) => {
    if (p.cmd !== 7) return undefined;
    stops += 1;
    // The gateway takes every stop, the timer keeps watering; the second
    // stop is first answered "busy", then taken 250 ms later.
    return stops === 2
      ? { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 8 }
      : { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 0 };
  });
  brain.timer(TAP1).watering = true;
  const { press, clock, app } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  await clock.advance(6 * SECOND);
  assert.equal(stops, 3);
  assert.equal(app.data.guards[TAP1].stop.resends, 1);
});

test('B1: the 10 s ticker never resends a stop whose timer was read dry', async () => {
  const { net, clock, app } = await setup({ created: [P] });
  app.data.guards[TAP1] = {
    gatewayId: GW,
    stop: { at: NOW, acked: false, dry: true, resends: 0, seenWatering: 0 },
  };
  app.retryStops();
  await clock.advance(25 * SECOND);
  assert.equal(cmd7(net), 0);
});

test('a resend never races the stop of the click while /data is written', async () => {
  const store = new MemoryStore(knownData(), { hangSaves: true });
  const { brain, click, clock, app, drive } = await setup({ store, created: [P] });
  brain.timer(TAP1).watering = true;
  app.data.guards[TAP1] = {
    gatewayId: GW,
    stop: { at: NOW, acked: false, dry: false, resends: 0, seenWatering: 0 },
  };
  const pressed = click(TAP1, 'stop');
  await clock.advance(100);
  app.retryStops();
  await drive(pressed);
  assert.equal(brain.count(7, TAP1), 1);
});

test('a reading sent before the pause never lifts its guard', async () => {
  const { brain, press, app } = await setup({ created: [P] });
  brain.radioMs = 10 * MINUTE;
  brain.schedule = () => {};
  await press(TAP1, 'pause_plan');
  assert.ok(app.data.guards[TAP1].pause);
  const gateway = app.data.gateways[GW];
  app.watchGuards(gateway, TAP1, { watering: false, paused: true }, { seq: 1 });
  assert.ok(app.data.guards[TAP1].pause, 'an old reading proves nothing');
  app.watchGuards(gateway, TAP1, { watering: false, paused: true }, { seq: app.sequence + 1 });
  assert.equal(app.data.guards[TAP1]?.pause, undefined);
});

// --- I2: a run of the same length started elsewhere ---------------------------

/** The gateway takes the stops; `onStop` decides what the timer does. */
function runBrain(onStop = () => {}) {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => {
    if (p.cmd === 7) {
      brain.timer(TAP1).stops += 1;
      onStop(brain.timer(TAP1));
      return { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 0 };
    }
    return answer(p);
  };
  return brain;
}

async function readNow(app, drive) {
  app.status.next = 0;
  await drive(app.read());
}

test('I2: another length: another run, never stopped', async () => {
  const brain = runBrain((t) => Object.assign(t, { total: 600, remaining: 400 }));
  Object.assign(brain.timer(TAP1), { watering: true, total: 900, remaining: 500 });
  const { press, clock, app } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  await clock.advance(MINUTE);
  assert.equal(brain.timer(TAP1).stops, 1);
  assert.equal(app.data.guards[TAP1]?.stop, undefined);
});

test('I2: the same length, a time left grown: another run, never stopped', async () => {
  const brain = runBrain((t) => Object.assign(t, { remaining: 550 }));
  Object.assign(brain.timer(TAP1), { watering: true, total: 900, remaining: 500 });
  const { press, clock } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  await clock.advance(MINUTE);
  assert.equal(brain.timer(TAP1).stops, 1);
});

test('I2: the run seen at the click is the reference, not the first one read after', async () => {
  // The app starts another run right as the stop lands.
  const brain = runBrain((t) => Object.assign(t, { total: 600, remaining: 600 }));
  Object.assign(brain.timer(TAP1), { watering: true, total: 900, remaining: 500 });
  const { press, clock } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  await clock.advance(MINUTE);
  assert.equal(brain.timer(TAP1).stops, 1);
});

test('I2: the time left of the stopped run is followed until another run shows', async () => {
  const brain = runBrain();
  Object.assign(brain.timer(TAP1), { watering: true, total: 900, remaining: 500 });
  const { press, clock } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  brain.timer(TAP1).remaining = 480;
  await clock.advance(6 * SECOND);
  brain.timer(TAP1).remaining = 470;
  await clock.advance(10 * SECOND);
  const stops = brain.timer(TAP1).stops;
  assert.ok(stops >= 2, 'the same run gets the stop again');
  // Another run of the same length: its time left (490) is above 470.
  brain.timer(TAP1).remaining = 490;
  await clock.advance(MINUTE);
  assert.equal(brain.timer(TAP1).stops, stops);
});

/** A run 1 s old at the click, stopped by the radio 2.5 s later, the app restarts the same 10 min at 3 s. */
async function youngRun({ counting }) {
  const brain = runBrain();
  const timer = brain.timer(TAP1);
  Object.assign(timer, { watering: true, total: 600, remaining: 599 });
  const ctx = await setup({ brain, created: [P] });
  const { app, clock, click, drive } = ctx;
  timer.remaining = counting ? 598 : 599;
  await readNow(app, drive);
  const pressed = click(TAP1, 'stop');
  if (counting) timer.remaining = 597;
  await clock.advance(2500);
  timer.watering = false;
  await clock.advance(500);
  // The LinkTap app: the same 10 minutes.
  Object.assign(timer, { watering: true, total: 600, remaining: counting ? 598 : 599 });
  await drive(pressed);
  await clock.advance(MINUTE);
  return { brain, app };
}

test('I2: a gateway counting the time left down: a run younger than the stop is another run', async () => {
  const { brain, app } = await youngRun({ counting: true });
  assert.equal(brain.timer(TAP1).stops, 1);
  assert.equal(app.data.guards[TAP1]?.stop, undefined);
});

test('I2: a time left that does not count down proves nothing: the stop wins', async () => {
  const { brain } = await youngRun({ counting: false });
  assert.ok(brain.timer(TAP1).stops >= 2);
});

test('B1: a taken stop resent and answered "busy" is not counted', async () => {
  let stops = 0;
  const brain = busyBrain((p) => {
    if (p.cmd !== 7) return undefined;
    stops += 1;
    // Taken first (the timer keeps watering), then busy twice (the resend and its retry).
    return stops === 2 || stops === 3
      ? { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 8 }
      : { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 0 };
  });
  brain.timer(TAP1).watering = true;
  const { press, clock, app } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  await clock.advance(6 * SECOND);
  assert.equal(stops, 3);
  assert.equal(app.data.guards[TAP1].stop.resends, 0);
});

test('the outcome of a queued start leaves the status after half an hour', async () => {
  const { app, clock, gladys } = await setup({ created: [P] });
  app.noteLate(app.data.gateways[GW].timers[0], 'notSent', { kind: 'late' });
  assert.match(gladys.fake.connectionStatus.message.en, /Start of .*: Not sent/);
  await clock.advance(31 * MINUTE);
  app.updateStatus();
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /Start of/);
});
