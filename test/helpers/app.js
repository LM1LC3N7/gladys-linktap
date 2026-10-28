// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted gateway and a virtual
// clock that moves at every read (testkit testClock).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock } from '../kit/index.mjs';
import { LinkTapApp } from '../../src/app.js';
import { LinkTapClient } from '../../src/linktap/client.js';
import { MemoryStore, emptyData } from '../../src/store.js';
import { registerHandlers } from '../../src/handlers.js';
import { buildTimerDevice } from '../../src/model.js';
import { GW, TAP1, fakeRequest, gatewayBrain } from './gateway.js';

export const SELECTOR = 'linktap';
export const ADDRESS = '192.168.1.50';
export const NOW = Date.UTC(2026, 5, 1, 10, 0, 0);
export const CONFIG = { address: ADDRESS, allow_watering: true };
export const F = (timerId, key) => `ext:${SELECTOR}:linktap:${timerId}:${key}`;

export const quiet = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
};

/** /data holding a known gateway (as after a first read). */
export function knownData({
  timers = [{ id: TAP1, name: 'Potager' }],
  guards = {},
  address = ADDRESS,
} = {}) {
  return {
    ...emptyData(),
    gateways: { [GW]: { id: GW, address, version: 'G06', volumeUnit: 'L', timers } },
    guards,
  };
}

/** The device of a timer as the user created it. */
export function createdDevice(gladys, timer = { id: TAP1, name: 'Potager' }) {
  return buildTimerDevice(gladys, { id: GW, address: ADDRESS }, timer, { language: 'fr' });
}

export async function setup({
  config = CONFIG,
  data,
  store,
  brain = gatewayBrain(),
  created = [],
  connect = true,
  start = true,
  failConfig = 0,
} = {}) {
  const clock = testClock({ start: NOW });
  const net = fakeRequest(brain, clock);
  const gladys = createFakeGladys({ selector: SELECTOR, config });
  for (const timer of created) {
    gladys.fake.devices.push(createdDevice(gladys, timer));
  }
  const logger = quiet();
  const memory = store ?? new MemoryStore(data ?? emptyData(), { now: clock.now });
  const app = new LinkTapApp({
    gladys,
    logger,
    client: new LinkTapClient({ request: net.request }),
    store: memory,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  // getConfig of the app failing `failConfig` times (the first call is the
  // SDK's own resynchronization, before 'connected').
  let configCalls = 0;
  const realGetConfig = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    configCalls += 1;
    if (configCalls > 1 && configCalls <= 1 + failConfig) throw new Error('Gladys busy');
    return realGetConfig();
  };
  registerHandlers(gladys, app, logger);
  const ctx = {
    app,
    gladys,
    clock,
    net,
    brain,
    store: memory,
    logger,
    configCalls: () => configCalls,
  };
  ctx.drive = (promise, max = 30_000) => drive(clock, promise, max);
  /** A click, not driven: the promise of its ack. */
  ctx.click = (timerId, key, value = 1) => {
    const device =
      gladys.fake.devices.find((d) => d.external_id === `ext:${SELECTOR}:linktap:${timerId}`) ??
      createdDevice(gladys, { id: timerId, name: '' });
    const feature = device.features.find((f) => f.external_id === F(timerId, key)) ?? {
      external_id: F(timerId, key),
    };
    return gladys.fake.setValue(device, feature, value);
  };
  ctx.press = (timerId, key, value = 1) => ctx.drive(ctx.click(timerId, key, value));
  if (connect) {
    await gladys.connect();
    if (start) {
      await ctx.drive(waitStarted(app));
    }
  }
  return ctx;
}

/** Resolves once the app applied a configuration. */
async function waitStarted(app) {
  for (let i = 0; i < 1000 && !app.config; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  await app.applying;
}

/** Moves the virtual clock by small steps until the promise settles. */
export async function drive(clock, promise, max = 30_000) {
  let done = false;
  let value;
  let error;
  promise.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      error = e;
    },
  );
  for (let t = 0; t <= max && !done; t += 50) {
    await clock.advance(50);
  }
  if (!done) throw new Error('still pending after the virtual time allowed');
  if (error) throw error;
  return value;
}
