// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), sped
// up 20 times, against a real local HTTP server playing the gateway: the reads
// really happen every interval (never sooner), a stop pressed while a read
// hangs leaves within its deadline.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { httpServer, measurePeriod, realClock, spyOn } from './kit/index.mjs';
import { LinkTapApp } from '../src/app.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { MemoryStore } from '../src/store.js';
import { registerHandlers } from '../src/handlers.js';
import { TAP1, gatewayBrain } from './helpers/gateway.js';
import { createdDevice, quiet } from './helpers/app.js';

const SPEED = 20;

test('real clock x20: one read per interval, a stop through a hanging read', async (t) => {
  const brain = gatewayBrain();
  let hang = false;
  const srv = await httpServer({
    routes: {
      'POST /api.shtml': (r) => (hang && r.json?.cmd === 3 ? 'silent' : brain.handle(r.json)),
    },
  });
  t.after(() => srv.close());
  const clock = realClock({ speed: SPEED });
  t.after(() => clock.close());
  const gladys = createFakeGladys({ selector: 'linktap', config: {} });
  const app = new LinkTapApp({
    gladys,
    logger: quiet(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: new MemoryStore(undefined, { now: clock.now }),
  });
  t.after(() => app.stop());
  registerHandlers(gladys, app, quiet());
  await gladys.connect();
  const spy = spyOn(app, 'doRead', clock);
  await app.start({ address: `127.0.0.1:${srv.port}`, allow_watering: false });
  await measurePeriod(spy, { count: 3, period: POLL_INTERVAL.default * 1000 });
  // A read hangs; a stop is pressed: it cuts it and leaves.
  hang = true;
  brain.timer(TAP1).watering = true;
  while (!app.reading) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 20));
  const device = createdDevice(gladys);
  const pressed = performance.now();
  const ack = await gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id.endsWith(':stop')),
    1,
  );
  assert.ok(performance.now() - pressed < 5000, 'acked within Gladys timeout (real ms)');
  assert.equal(brain.count(7, TAP1), 1, ack.error);
  assert.equal(brain.timer(TAP1).watering, false);
});
