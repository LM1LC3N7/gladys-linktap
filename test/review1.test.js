// -----------------------------------------------------------------------------
// Review r1: the scenarios of the reviewer, replayed on the virtual clock, and
// one test per guard a mutation could break unnoticed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.js';
import { GW, TAP1, TAP2, gatewayBrain, raw } from './helpers/gateway.js';
import { ADDRESS, CONFIG, F, NOW, knownData, setup } from './helpers/app.js';

const SECOND = 1000;
const P = { id: TAP1, name: 'P' };
const cmdCount = (net, cmd, timerId) =>
  net.payloads.filter((p) => p.cmd === cmd && (timerId === undefined || p.dev_id === timerId))
    .length;
/** The brain takes the stops but the timer keeps watering. */
const ignoreStops = (brain) => {
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 7 ? { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 0 } : answer(p));
  return answer;
};
const slowRadio = (brain, clock, ms) => {
  brain.radioMs = ms;
  brain.schedule = (fn, delay) => clock.timers.setTimeout(fn, delay);
};

// --- B1: a stop clicked during an outage leaves when the gateway is back -----

test('B1: a stop clicked while the gateway refuses connections leaves when it is back', async () => {
  const { brain, net, press, clock, app } = await setup({ created: [P] });
  brain.timer(TAP1).watering = true;
  net.down = true;
  const ack = await press(TAP1, 'stop');
  assert.match(ack.error, /renvoie toutes les 10 s/);
  await clock.advance(60 * SECOND);
  assert.equal(brain.count(7, TAP1), 0);
  assert.equal(app.data.guards[TAP1].stop.resends, 0, 'nothing left: nothing counted');
  net.down = false;
  await clock.advance(11 * SECOND);
  assert.equal(brain.count(7, TAP1), 1);
  assert.equal(brain.timer(TAP1).watering, false);
  assert.equal(app.data.guards[TAP1].stop.acked, true);
});

test('B1: after a restart with the gateway down 35 s, the stop of /data leaves when it is back', async () => {
  const data = knownData({
    guards: { [TAP1]: { gatewayId: GW, stop: { at: NOW - 5000, acked: false, resends: 0 } } },
  });
  const brain = gatewayBrain();
  brain.timer(TAP1).watering = true;
  const { net, clock, app, drive } = await setup({ data, brain, connect: false });
  net.down = true;
  await drive(app.boot());
  await clock.advance(35 * SECOND);
  assert.equal(brain.count(7, TAP1), 0);
  net.down = false;
  await clock.advance(11 * SECOND);
  assert.equal(brain.count(7, TAP1), 1);
  assert.equal(brain.timer(TAP1).watering, false);
});

// --- B2: the option applies on receipt ---------------------------------------

test('B2: two saves during a slow read, the option unticked: a start is refused at once', async () => {
  const { brain, net, gladys, clock, press, app } = await setup({ created: [P] });
  net.latencyMs = (p) => (p.cmd === 3 ? 2500 : 0);
  await clock.advance(30 * SECOND);
  assert.ok(app.reading, 'a slow read is running');
  gladys.fake.configUpdated({ ...CONFIG, poll_interval: 60 });
  gladys.fake.configUpdated({ ...CONFIG, poll_interval: 60, allow_watering: false });
  await clock.advance(100);
  const result = await press(TAP1, 'start');
  assert.equal(result.success, false);
  assert.match(result.error, /désactivé/);
  assert.equal(cmdCount(net, 6), 0);
  await clock.advance(20 * SECOND);
  assert.equal(brain.count(6), 0);
});

// --- I1: only a reading sent after the click decides -------------------------

test('I1: a dry reading sent before the stop click never marks the stop "dry"', async () => {
  const brain = gatewayBrain();
  ignoreStops(brain);
  const { net, clock, click, drive, app } = await setup({ brain, created: [P] });
  net.latencyMs = (p) => (p.cmd === 3 && p.dev_id === TAP1 ? 800 : 0);
  await clock.advance(30 * SECOND);
  // The read of TAP1 left (dry); the timer starts watering right after.
  brain.timer(TAP1).watering = true;
  await clock.advance(100);
  await drive(click(TAP1, 'stop'));
  assert.equal(app.data.guards[TAP1].stop.dry, false);
});

test('I1: a watering reading sent before a start click never lifts its guard', async () => {
  const brain = gatewayBrain();
  brain.timer(TAP1).watering = true;
  const { net, clock, click, drive, press } = await setup({ brain, created: [P] });
  net.latencyMs = (p) => (p.cmd === 3 && p.dev_id === TAP1 ? 800 : 0);
  await clock.advance(30 * SECOND);
  // The poll's read of TAP1 left (watering); the watering ends right after.
  brain.timer(TAP1).watering = false;
  slowRadio(brain, clock, 2 * 60 * SECOND);
  await clock.advance(100);
  const first = await drive(click(TAP1, 'start'));
  assert.match(first.error ?? '', /sans confirmation|En file/);
  const again = await press(TAP1, 'start');
  assert.match(again.error, /vient de partir/);
  assert.equal(brain.count(6, TAP1), 1);
});

test('I1: no resend while the stop of the click is out', async () => {
  const brain = gatewayBrain();
  brain.timer(TAP1).watering = true;
  const { net, clock, click, drive } = await setup({ brain, created: [P] });
  net.latencyMs = (p) => (p.cmd === 7 ? 900 : 0);
  const pressed = click(TAP1, 'stop');
  await clock.advance(10);
  // A poll reading sent now still sees the run: the stop is out, nothing more.
  await drive(pressed);
  assert.equal(brain.count(7, TAP1), 1);
});

// --- I2: a run started elsewhere after the stop is not cut -------------------

test('I2: a watering started by the LinkTap app after the stop is never cut', async () => {
  const brain = gatewayBrain();
  Object.assign(brain.timer(TAP1), { watering: true, total: 900, remaining: 500 });
  const { clock, press, app } = await setup({ brain, created: [P] });
  slowRadio(brain, clock, 2500);
  await press(TAP1, 'stop');
  // The stop reaches the timer by radio (2.5 s), then the app starts 10 min.
  await clock.advance(2 * SECOND);
  assert.equal(brain.timer(TAP1).watering, false);
  Object.assign(brain.timer(TAP1), { watering: true, total: 600, remaining: 600 });
  await clock.advance(2 * 60 * SECOND);
  assert.equal(brain.count(7, TAP1), 1);
  assert.equal(brain.timer(TAP1).watering, true);
  assert.equal(app.data.guards[TAP1]?.stop, undefined, 'lifted: seen twice in a row');
});

test('I2: the same run still watering after the stop gets the stop again', async () => {
  const brain = gatewayBrain();
  ignoreStops(brain);
  Object.assign(brain.timer(TAP1), { watering: true, total: 900, remaining: 500 });
  const { clock, press } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  brain.timer(TAP1).remaining = 480;
  await clock.advance(40 * SECOND);
  assert.ok(brain.count(7, TAP1) >= 2);
});

// --- I3: never a second pause of the plan -------------------------------------

test('I3: a second pause while the radio carries the first one is refused', async () => {
  const { brain, press, clock, app } = await setup({ created: [P] });
  slowRadio(brain, clock, 2000);
  await press(TAP1, 'pause_plan');
  const again = await press(TAP1, 'pause_plan');
  assert.match(again.error, /vient de partir/);
  assert.deepEqual(brain.timer(TAP1).pauses, [24]);
  // Seen paused by a later read: the guard goes; a click then sends nothing.
  await clock.advance(40 * SECOND);
  assert.equal(app.data.guards[TAP1]?.pause, undefined);
  const third = await press(TAP1, 'pause_plan');
  assert.equal(third.success, true, third.error);
  assert.deepEqual(brain.timer(TAP1).pauses, [24]);
  assert.notEqual(brain.timer(TAP1).planOff, true);
});

test('I3: a firmware without is_paused: the pause is refused, nothing sent', async () => {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => {
    const a = answer(p);
    if (p.cmd === 3 && a.ret === 0) delete a.is_paused;
    return a;
  };
  const { press } = await setup({ brain, created: [P] });
  const result = await press(TAP1, 'pause_plan');
  assert.match(result.error, /n'a pas pu être lu/);
  assert.equal(brain.count(18), 0);
});

test('I3: the pause length is capped in the code', async () => {
  const { brain, press, app } = await setup({ created: [P] });
  app.latest.pauseHours = 100_000;
  await press(TAP1, 'pause_plan');
  assert.deepEqual(brain.timer(TAP1).pauses, [240]);
});

// --- I4: a silent cmd 16 never holds the values -------------------------------

test('I4: a silent cmd 16 never holds the values of the known timers', async () => {
  const { brain, gladys, clock } = await setup({ created: [P] });
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 16 ? 'silent' : answer(p));
  brain.timer(TAP1).watering = true;
  await clock.advance(36 * SECOND);
  assert.equal(gladys.fake.lastState(F(TAP1, 'watering')), 1);
});

test('I4: a silent cmd 16 and an unreachable first timer: the read fails', async () => {
  const { brain, net, gladys, clock } = await setup({ created: [P] });
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 16 ? 'silent' : p.cmd === 3 ? 'silent' : answer(p));
  void net;
  await clock.advance(40 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  // The gateway itself failed (not "no timer read").
  assert.match(gladys.fake.connectionStatus.message.en, /no answer in time/);
});

// --- I5: "queued" is honest ---------------------------------------------------

test('I5: a start answered "queued" that never leaves is told in the status', async () => {
  const ids = [
    'A0000000000000A1',
    'A0000000000000A2',
    'A0000000000000A3',
    'A0000000000000A4',
    'A0000000000000A5',
  ];
  const brain = gatewayBrain({ timers: ids.map((id) => ({ id, name: id })) });
  const { net, click, drive, clock, gladys } = await setup({
    brain,
    created: ids.map((id) => ({ id, name: id })),
  });
  net.latencyMs = 1300;
  const acks = await drive(Promise.all(ids.map((id) => click(id, 'start'))));
  assert.ok(acks.some((a) => /peut partir jusqu'à 10 s/.test(a.error ?? '')));
  await clock.advance(15 * SECOND);
  const sent = ids.filter((id) => brain.timer(id).starts.length === 1).length;
  assert.ok(sent < 5);
  assert.match(gladys.fake.connectionStatus.message.fr, /Démarrage de .* : Non envoyé/);
});

// --- m3: every timer failing is not "connected" -------------------------------

test('m3: every timer unknown to the gateway: not connected', async () => {
  const brain = gatewayBrain();
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 3 && p.dev_id ? { cmd: 3, gw_id: GW, ret: 5 } : answer(p));
  const { gladys } = await setup({ brain });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /No water timer could be read/);
});

// --- The guards of checkStart, one by one ------------------------------------

test('checkStart at the turn of the start request: nothing is even attempted', async () => {
  const brain = gatewayBrain();
  const { net, press, app } = await setup({ brain, created: [P] });
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => {
    if (p.cmd === 3 && p.dev_id === TAP1) app.latest.allowWatering = false;
    return answer(p);
  };
  const result = await press(TAP1, 'start');
  assert.equal(result.success, false);
  assert.equal(cmdCount(net, 6), 0);
});

test('checkStart at the turn of the status read: nothing is even attempted', async () => {
  const { net, clock, click, drive, app } = await setup({ created: [P] });
  net.latencyMs = (p) => (p.cmd === 16 ? 2000 : 0);
  await clock.advance(30 * SECOND);
  const before = net.payloads.length;
  const pressed = click(TAP1, 'start');
  await clock.advance(100);
  app.latest.allowWatering = false;
  await drive(pressed);
  const after = net.payloads.slice(before).filter((p) => p.dev_id === TAP1 && p.cmd !== 3);
  assert.deepEqual(after, []);
  // The start's own status read never left either (only the poll's reads).
  const reads = net.payloads.slice(before).filter((p) => p.cmd === 3 && p.dev_id === TAP1);
  assert.ok(reads.length <= 1);
  assert.equal(cmdCount(net, 6), 0);
});

test('checkStart: a start cancelled by a stop never lifts the newer stop guard', async () => {
  const brain = gatewayBrain();
  brain.timer(TAP1).watering = true;
  const { net, clock, click, drive, app } = await setup({ brain, created: [P] });
  ignoreStops(brain);
  net.latencyMs = (p) => (p.cmd === 3 ? 500 : 0);
  const start = click(TAP1, 'start');
  await clock.advance(100);
  const stop = click(TAP1, 'stop');
  const [started] = await drive(Promise.all([start, stop]));
  assert.match(started.error, /Annulé/);
  assert.ok(app.data.guards[TAP1]?.stop, 'the stop guard stays');
});

test('checkStart: the configuration changed and back while the start waits: refused', async () => {
  const { net, clock, click, drive, gladys, brain } = await setup({ created: [P] });
  // Only the gateway of the configuration answers (the other address never does).
  net.onlyHost = ADDRESS;
  net.latencyMs = (p) => (p.cmd === 16 ? 2000 : 0);
  await clock.advance(30 * SECOND);
  const pressed = click(TAP1, 'start');
  await clock.advance(50);
  gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.51' });
  gladys.fake.configUpdated({ ...CONFIG });
  const result = await drive(pressed);
  assert.equal(result.success, false);
  await clock.advance(5 * SECOND);
  assert.equal(brain.count(6), 0);
});

test('checkStart: a pause asked by the gateway refuses a start', async () => {
  const { brain, clock, press, app } = await setup({ created: [P] });
  brain.next.push(raw(503));
  await clock.advance(31 * SECOND);
  assert.ok(app.paused());
  const result = await press(TAP1, 'start');
  assert.match(result.error, /pause/);
  assert.equal(brain.count(6), 0);
});

test('checkStart: a start whose turn comes after 10 s is dropped unsent', async () => {
  const ids = [
    'A0000000000000A1',
    'A0000000000000A2',
    'A0000000000000A3',
    'A0000000000000A4',
    'A0000000000000A5',
  ];
  const brain = gatewayBrain({ timers: ids.map((id) => ({ id, name: id })) });
  const {
    net,
    click,
    drive,
    clock,
    gladys: g,
  } = await setup({
    brain,
    created: ids.map((id) => ({ id, name: id })),
  });
  const status = () => g.fake.connectionStatus.message;
  net.latencyMs = (p) => (p.cmd === 6 ? 2900 : 0);
  await drive(Promise.all(ids.map((id) => click(id, 'start'))));
  await clock.advance(20 * SECOND);
  assert.equal(brain.timer(ids[4]).starts.length, 0);
  // Dropped by the 10 s check at its turn, said so in the status.
  assert.match(status().fr, /pas libre à temps/);
});

test('checkStart: the gateway is not the one of the configuration any more: refused', async () => {
  const { net, gladys, clock, press, brain } = await setup({ created: [P] });
  net.down = true;
  gladys.fake.configUpdated({ ...CONFIG, address: '192.168.1.77' });
  await clock.advance(SECOND);
  const result = await press(TAP1, 'start');
  assert.match(result.error, /pas \(plus\) connu/);
  assert.equal(brain.count(6), 0);
});

test('start: a second click while the first waits says so', async () => {
  const { net, click, drive, clock } = await setup({ created: [P] });
  net.latencyMs = (p) => (p.cmd === 3 ? 1000 : 0);
  const first = click(TAP1, 'start');
  await clock.advance(100);
  const second = await drive(click(TAP1, 'start'));
  assert.match(second.error, /attend déjà/);
  await drive(first);
});

test('setValue: a button value other than 1 is refused', async () => {
  const { brain, press } = await setup({ created: [P] });
  const result = await press(TAP1, 'stop', 2);
  assert.match(result.error, /Valeur inattendue/);
  assert.equal(brain.count(7), 0);
});

// --- The stop -----------------------------------------------------------------

test('stop: a disk that never answers never holds it', async () => {
  const store = new MemoryStore(knownData(), { hangSaves: true });
  const { brain, press } = await setup({ store, created: [P] });
  brain.timer(TAP1).watering = true;
  await press(TAP1, 'stop');
  assert.equal(brain.count(7, TAP1), 1);
});

test('stop: never written after its deadline (checked in beforeSend)', async () => {
  const { brain, net, click, clock } = await setup({ created: [P] });
  net.ignoreDeadlines = true;
  net.connectMs = 3500;
  const ack = click(TAP1, 'stop');
  await clock.advance(6 * SECOND);
  assert.equal(brain.count(7, TAP1), 0);
  assert.match((await ack).error, /pas libre à temps/);
});

test('stop: the resends go one at a time', async () => {
  const { net, clock, app } = await setup({ created: [P] });
  net.latencyMs = (p) => (p.cmd === 7 ? 2000 : 0);
  app.data.guards[TAP1] = {
    gatewayId: GW,
    stop: { at: NOW, acked: false, dry: false, resends: 0, seenWatering: 0 },
  };
  app.retryStops();
  app.retryStops();
  await clock.advance(100);
  assert.equal(cmdCount(net, 7, TAP1), 1);
});

test('stop: its retry 250 ms later yields to a start that took over', async () => {
  const brain = gatewayBrain();
  brain.timer(TAP1).watering = true;
  const { net, click, clock, drive } = await setup({ brain, created: [P] });
  net.down = true;
  const stop = click(TAP1, 'stop');
  await clock.advance(20);
  net.down = false;
  // The start reads the timer watering: the click asks for watering.
  const start = click(TAP1, 'start');
  await drive(Promise.all([stop, start]));
  await clock.advance(5 * SECOND);
  assert.equal(brain.count(7, TAP1), 0);
});

test('stop: a request streaming bytes is cut after 1.5 s of waiting', async () => {
  const { brain, net, clock, click } = await setup({ created: [P] });
  brain.timer(TAP1).watering = true;
  net.trickleMs = 200;
  net.latencyMs = (p) => (p.cmd === 3 ? 2900 : 0);
  await clock.advance(30 * SECOND);
  click(TAP1, 'stop');
  await clock.advance(1800);
  assert.equal(brain.count(7, TAP1), 1);
});

test('a read reaching the gateway sends at once the stop it has not taken yet', async () => {
  const { brain, net, click, drive, clock, app } = await setup({ created: [P] });
  brain.timer(TAP1).watering = true;
  net.down = true;
  await drive(click(TAP1, 'stop'));
  await clock.advance(61_500);
  net.down = false;
  // The status of the timer is unreadable this time: the stop goes all the same.
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 3 ? { cmd: 3, gw_id: GW, ret: 1 } : answer(p));
  app.status.next = 0;
  app.read();
  await clock.advance(20);
  assert.equal(brain.count(7, TAP1), 1);
});

test('a later save applies at once, even while a read hangs', async () => {
  const { net, gladys, clock, app } = await setup({ created: [P] });
  net.latencyMs = (p) => (p.cmd === 3 ? 2500 : 0);
  await clock.advance(30 * SECOND);
  gladys.fake.configUpdated({ ...CONFIG, poll_interval: 60 });
  gladys.fake.configUpdated({ ...CONFIG, poll_interval: 90 });
  await clock.advance(100);
  assert.equal(app.config.pollInterval, 90);
});

test('a confirmation read that lost its race leaves the queue unsent', async () => {
  const { brain, net, click, clock } = await setup({ created: [P, { id: TAP2, name: 'L' }] });
  brain.timer(TAP1).watering = true;
  net.latencyMs = (p) => (p.cmd === 3 && p.dev_id === TAP2 ? 2900 : 0);
  click(TAP1, 'stop');
  await clock.advance(500);
  click(TAP2, 'pause_plan');
  await clock.advance(2900);
  const before = net.payloads.length;
  await clock.advance(1000);
  const late = net.payloads.slice(before).filter((p) => p.cmd === 3 && p.dev_id === TAP1);
  assert.deepEqual(late, []);
});

test('pause: /data not writable: refused, nothing sent', async () => {
  const store = new MemoryStore(knownData(), { failSaves: true });
  const { brain, press } = await setup({ store, created: [P] });
  const result = await press(TAP1, 'pause_plan');
  assert.match(result.error, /enregistré/);
  assert.equal(brain.count(18), 0);
});
