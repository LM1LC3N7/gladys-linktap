// -----------------------------------------------------------------------------
// Review r3: the age proof and the radio delay count from the departure of a
// reading (the gateway measures during the request, up to 3 s before its
// answer), never from its answer: a stop ignored by the radio keeps its guard
// and its resends. Plus the 404 on a resend, and a new click after 5 minutes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GW, TAP1, gatewayBrain, raw } from './helpers/gateway.js';
import { CONFIG, createdDevice, setup } from './helpers/app.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const P = { id: TAP1, name: 'P' };
const cmd7 = (net) => net.payloads.filter((p) => p.cmd === 7).length;

/**
 * One water timer whose time left counts down on the virtual clock, measured
 * when the request reaches the gateway (before its answer, as a real one).
 * `stopAnswer(n, payload)` answers the n-th stop; by default it is taken and
 * the radio ignores it (the same run goes on).
 */
function liveBrain({ stopAnswer = () => undefined } = {}) {
  const brain = gatewayBrain({ timers: [P] });
  const answer = brain.answer.bind(brain);
  const timer = brain.timer(TAP1);
  let stops = 0;
  brain.answer = (p) => {
    if (p.cmd === 3 && timer.startedAt !== undefined) {
      const age = Math.floor((brain.clock.elapsed - timer.startedAt) / SECOND);
      timer.remaining = Math.max(0, timer.total - age);
    }
    if (p.cmd === 7) {
      stops += 1;
      return stopAnswer(stops, p) ?? { cmd: 7, gw_id: GW, dev_id: p.dev_id, ret: 0 };
    }
    return answer(p);
  };
  brain.run = (total, age = 0) =>
    Object.assign(timer, {
      watering: true,
      total,
      remaining: total,
      startedAt: brain.clock.elapsed - age,
    });
  brain.end = () => Object.assign(timer, { watering: false, remaining: 0, startedAt: undefined });
  brain.stops = () => stops;
  return brain;
}

async function readNow({ app, drive }) {
  app.status.next = 0;
  await drive(app.read());
}

/** The app on a live gateway already seen counting the time left down (an earlier run). */
async function counted(brain) {
  const ctx = await setup({ brain, created: [P] });
  brain.clock = ctx.clock;
  brain.run(600);
  await readNow(ctx);
  await ctx.clock.advance(2 * SECOND);
  await readNow(ctx);
  assert.ok(ctx.app.countsDown.has(TAP1), 'the gateway was seen counting down');
  brain.end();
  await readNow(ctx);
  return ctx;
}

// --- I1: the age proof counts from the departure of the reading ---------------

test('I1 (r3): a stop ignored by the radio, a run 0.5 s old, reads answered in 2.5 s: the guard stays and the 3 resends leave', async () => {
  const brain = liveBrain();
  const ctx = await counted(brain);
  const { app, clock, net, click, drive, gladys, logger } = ctx;
  // The run to stop: read at 0.2 s, the stop clicked at about 0.5 s.
  brain.run(1200);
  await clock.advance(200);
  await readNow(ctx);
  net.latencyMs = (p) => (p.cmd === 3 ? 2500 : 0);
  await clock.advance(250);
  await drive(click(TAP1, 'stop'));
  await clock.advance(70 * SECOND);
  const stop = app.data.guards[TAP1]?.stop;
  assert.ok(stop, 'the stop guard is kept: the same run still waters');
  assert.equal(stop.acked, true);
  assert.equal(stop.resends, 3);
  assert.equal(brain.stops(), 4, 'the stop of the click and its 3 resends');
  assert.equal(brain.timer(TAP1).watering, true);
  assert.ok(!logger.lines.some((l) => /started elsewhere/.test(l)), logger.lines.join('\n'));
  assert.match(gladys.fake.connectionStatus.message.en, /Still watering after a stop/);
});

test('I1 (r3): the age proof counts from the departure of the reading, with a margin for the rounding', async () => {
  const brain = liveBrain();
  const ctx = await counted(brain);
  const { app, clock, press } = ctx;
  // A run seen just started, stopped at once (the radio ignores the stop).
  brain.run(600);
  await readNow(ctx);
  await press(TAP1, 'stop');
  const clickAt = app.stopClickAt.get(TAP1);
  assert.equal(app.stopRun.get(TAP1)?.total, 600);
  const reading = (elapsed) => ({ watering: true, total: 600, remaining: 600 - elapsed });
  // Answered well after it left: only the departure counts.
  await clock.advance(clickAt + 4 * SECOND - clock.elapsed);
  // The same run, its elapsed time rounded down to the second: 0.9 s under
  // the time from the click to the departure of the reading.
  assert.equal(app.isNewRun(TAP1, reading(1), { at: clickAt + 1900 }), false);
  assert.equal(app.isNewRun(TAP1, reading(0), { at: clickAt + 900 }), false);
  // 1.6 s under it: a run started after the click.
  assert.equal(app.isNewRun(TAP1, reading(1), { at: clickAt + 2600 }), true);
  // A reading whose departure is unknown proves nothing.
  assert.equal(app.isNewRun(TAP1, reading(0), {}), false);
});

test('I1 (r3): the radio delay of a taken stop counts to the departure of the reading', async () => {
  const brain = liveBrain();
  const ctx = await counted(brain);
  const { app, clock, net, press, drive } = ctx;
  brain.run(600, 60);
  await readNow(ctx);
  await press(TAP1, 'stop');
  const takenAt = app.stopTakenAt.get(TAP1);
  assert.equal(brain.stops(), 1);
  // A reading leaving 3 s after the stop was taken, answered 2.5 s later.
  await clock.advance(takenAt + 3 * SECOND - clock.elapsed);
  net.latencyMs = (p) => (p.cmd === 3 ? 2500 : 0);
  app.status.next = 0;
  await drive(app.read());
  assert.equal(brain.stops(), 1, 'sent before the radio could carry the stop: proves nothing');
  // The next reading (the follow-up at 15 s) sends it again.
  await clock.advance(15 * SECOND);
  assert.ok(brain.stops() >= 2);
  assert.ok(app.data.guards[TAP1].stop);
});

test('I1 (r3): the confirmation read of another command is dated at its departure too', async () => {
  const brain = liveBrain();
  const ctx = await counted(brain);
  const { app, clock, press } = ctx;
  brain.run(600, 60);
  await readNow(ctx);
  await press(TAP1, 'stop');
  const takenAt = app.stopTakenAt.get(TAP1);
  // A pause 3 s after the stop was taken: its confirmation read leaves 1.2 s later.
  await clock.advance(takenAt + 3 * SECOND - clock.elapsed);
  const paused = await press(TAP1, 'pause_plan');
  assert.equal(paused.success, true, paused.error);
  await clock.advance(300);
  assert.ok(clock.elapsed - app.stopClickAt.get(TAP1) < 5 * SECOND, 'before the follow-up read');
  assert.equal(brain.stops(), 2, 'the same run read 4.2 s after the take: the stop is sent again');
});

test('a value is as old as the departure of its read: never fresh again at a device creation', async () => {
  const createdAfter = async (ms) => {
    const brain = gatewayBrain({ timers: [P] });
    brain.timer(TAP1).watering = true;
    const { app, clock, net, gladys, drive } = await setup({
      brain,
      config: { ...CONFIG, poll_interval: 15 },
    });
    net.latencyMs = (p) => (p.cmd === 3 ? 2500 : 0);
    app.status.next = 0;
    const read = app.read();
    const leftAt = clock.elapsed;
    await drive(read);
    // The gateway goes away: no newer value.
    net.down = true;
    await clock.advance(leftAt + ms - clock.elapsed);
    const before = gladys.fake.states.length;
    await gladys.fake.deviceCreated(createdDevice(gladys, P));
    await clock.advance(2 * SECOND);
    return gladys.fake.states.length > before;
  };
  // Two intervals (30 s) at most since the read left, not since its answer (2.5 s later).
  assert.equal(await createdAfter(28 * SECOND), true);
  assert.equal(await createdAfter(31 * SECOND), false);
});

for (const [key, state, cmd] of [
  ['start', { watering: true }, 6],
  ['pause_plan', { paused: true }, 18],
]) {
  test(`the values of the read deciding a ${key} are dated at its departure too`, async () => {
    const brain = gatewayBrain({ timers: [P] });
    Object.assign(brain.timer(TAP1), state);
    const { gladys, press, clock } = await setup({ brain });
    const result = await press(TAP1, key);
    assert.equal(result.success, true, result.error);
    assert.equal(brain.count(cmd), 0, 'nothing sent: the last read is its own');
    const before = gladys.fake.states.length;
    await gladys.fake.deviceCreated(createdDevice(gladys, P));
    await clock.advance(2 * SECOND);
    assert.ok(gladys.fake.states.length > before, 'its fresh values go to the new device');
  });
}

// --- Mutants of r3: a 404 on a resend, a new click after 5 minutes ------------

test('a resend of a taken stop answered 404 is tried again 250 ms later and never counted', async () => {
  // Taken first (the timer keeps watering), then 404 twice (the resend and its retry).
  const brain = liveBrain({ stopAnswer: (n) => (n === 2 || n === 3 ? raw(404) : undefined) });
  const ctx = await counted(brain);
  const { app, clock, press } = ctx;
  brain.run(600, 60);
  await readNow(ctx);
  await press(TAP1, 'stop');
  await clock.advance(6 * SECOND);
  assert.equal(brain.stops(), 3, 'the resend answered 404 is tried again');
  assert.equal(app.data.guards[TAP1].stop.resends, 0, 'a 404 shows nothing was applied');
  await clock.advance(10 * SECOND);
  assert.equal(brain.stops(), 4);
  assert.equal(app.data.guards[TAP1].stop.resends, 1);
});

test('the stop of a click answered 404 is tried again 250 ms later, within its 3 s', async () => {
  const brain = gatewayBrain({ timers: [P] });
  const answer = brain.answer.bind(brain);
  let stops = 0;
  brain.answer = (p) => {
    if (p.cmd !== 7) return answer(p);
    stops += 1;
    return stops === 1 ? raw(404) : answer(p);
  };
  brain.timer(TAP1).watering = true;
  const { press, app } = await setup({ brain, created: [P] });
  const ack = await press(TAP1, 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.equal(stops, 2);
  assert.equal(brain.timer(TAP1).watering, false);
  assert.equal(app.data.guards[TAP1].stop.acked, true);
});

test('a new click after 5 minutes of refusals is tried again every 10 s, not every minute', async () => {
  const brain = gatewayBrain({ timers: [P] });
  const answer = brain.answer.bind(brain);
  brain.answer = (p) => (p.cmd === 7 ? raw(404) : answer(p));
  brain.timer(TAP1).watering = true;
  const { net, press, clock } = await setup({ brain, created: [P] });
  await press(TAP1, 'stop');
  await clock.advance(6 * MINUTE);
  const before = cmd7(net);
  await clock.advance(MINUTE);
  assert.ok(cmd7(net) - before <= 6, `every minute after 5 minutes: ${cmd7(net) - before}`);
  const clicked = cmd7(net);
  await press(TAP1, 'stop');
  await clock.advance(MINUTE);
  const after = cmd7(net) - clicked;
  assert.ok(after >= 10, `every 10 s again after a new click: ${after} stops in a minute`);
});
