// -----------------------------------------------------------------------------
// A LinkTap gateway for the tests: its state machine (`gatewayBrain`, the
// answers of the local HTTP API) and an in-memory transport on a virtual clock
// (`fakeRequest`, the same contract as src/linktap/http.js). The brain also
// serves a real local HTTP server (test/http.test.js, test/realclock.test.js).
// -----------------------------------------------------------------------------

import { LinkTapError } from '../../src/linktap/errors.js';

export const GW = 'A1B2C3D4E5F60708';
export const OTHER_GW = 'FFEEDDCCBBAA0099';
export const TAP1 = '1111222233334444';
export const TAP2 = '5555666677778888';

/**
 * The gateway: `timers` [{ id, name, flowMeter }], `volUnit`, `schedule(fn,
 * ms)` for the radio delay of a command (immediate by default).
 */
export function gatewayBrain({
  id = GW,
  timers = [
    { id: TAP1, name: 'Potager' },
    { id: TAP2, name: 'Pelouse', flowMeter: true },
  ],
  volUnit = 'L',
  version = 'G0608062305191832I',
  radioMs = 0,
  schedule = (fn) => fn(),
} = {}) {
  const brain = {
    id,
    volUnit,
    version,
    radioMs,
    schedule,
    /** Every request received, parsed. */
    received: [],
    /** Forced answers for the next requests: an object, 'silent', or { status, body }. */
    next: [],
    state: new Map(),
    handle(payload) {
      brain.received.push(payload);
      if (brain.next.length > 0) {
        return brain.next.shift();
      }
      return brain.answer(payload);
    },
    answer(payload) {
      const cmd = payload?.cmd;
      if (payload?.gw_id === undefined) {
        // A request without ids: answered with the id of the gateway.
        return { cmd, gw_id: brain.id, ret: 1 };
      }
      if (payload.gw_id !== brain.id) {
        return { cmd, gw_id: brain.id, ret: 3 };
      }
      if (cmd === 16) {
        return {
          cmd: 16,
          gw_id: brain.id,
          ver: brain.version,
          vol_unit: brain.volUnit,
          end_dev: [...brain.state.keys()],
          dev_name: [...brain.state.values()].map((t) => t.name),
          ret: 0,
        };
      }
      const timer = brain.state.get(payload.dev_id);
      if (!timer) {
        return { cmd, gw_id: brain.id, dev_id: payload.dev_id, ret: 5 };
      }
      const later = (fn) => brain.schedule(fn, brain.radioMs);
      if (cmd === 3) {
        return {
          cmd: 3,
          gw_id: brain.id,
          dev_id: timer.id,
          ret: 0,
          is_rf_linked: timer.rfLinked,
          is_flm_plugin: timer.flowMeter,
          is_fall: false,
          is_broken: false,
          is_cutoff: false,
          is_leak: timer.leak ?? false,
          is_clog: false,
          signal: timer.signal,
          battery: timer.battery,
          child_lock: 0,
          is_manual_mode: false,
          is_watering: timer.watering,
          is_paused: timer.paused,
          is_final: true,
          total_duration: timer.total,
          remain_duration: timer.remaining,
          speed: timer.watering ? timer.speed : 0,
          volume: timer.volume,
          volume_limit: 0,
          failsafe_duration: 0,
          plan_mode: 2,
          plan_sn: 3134,
        };
      }
      if (cmd === 6) {
        later(() => {
          timer.watering = true;
          timer.total = payload.duration;
          timer.remaining = payload.duration;
        });
        timer.starts.push(payload.duration);
        return { cmd: 6, gw_id: brain.id, dev_id: timer.id, ret: 0 };
      }
      if (cmd === 7) {
        later(() => {
          timer.watering = false;
        });
        timer.stops += 1;
        return { cmd: 7, gw_id: brain.id, dev_id: timer.id, ret: 0 };
      }
      if (cmd === 18) {
        if (timer.paused) {
          // LinkTap issue #88: a second pause switches the plan off.
          timer.planOff = true;
        }
        later(() => {
          timer.paused = true;
        });
        timer.pauses.push(payload.duration);
        return { cmd: 18, gw_id: brain.id, dev_id: timer.id, ret: 0 };
      }
      return { cmd, gw_id: brain.id, ret: 2 };
    },
    timer: (timerId) => brain.state.get(timerId),
    count: (cmd, timerId) =>
      brain.received.filter(
        (p) => p?.cmd === cmd && (timerId === undefined || p.dev_id === timerId),
      ).length,
  };
  for (const t of timers) {
    brain.state.set(t.id, {
      id: t.id,
      name: t.name,
      flowMeter: t.flowMeter === true,
      rfLinked: t.rfLinked ?? true,
      watering: t.watering ?? false,
      paused: t.paused ?? false,
      battery: t.battery ?? 87,
      signal: t.signal ?? 71,
      total: 0,
      remaining: 0,
      speed: t.speed ?? 12.5,
      volume: t.volume ?? 0,
      starts: [],
      stops: 0,
      pauses: [],
    });
  }
  return brain;
}

/**
 * The transport of src/linktap/http.js against a brain, on a virtual clock:
 * `connectMs`, `latencyMs` (or a function of the payload), `down` (no
 * connection), `silent` (connected, never answers). Counts the requests in
 * flight (`open`, `peak`): the gateway takes one at a time.
 */
export function fakeRequest(brain, clock) {
  const net = {
    connectMs: 0,
    latencyMs: 0,
    down: false,
    silent: false,
    open: 0,
    peak: 0,
    attempts: 0,
  };
  const later = (ms, fn) => {
    if (ms <= 0) {
      queueMicrotask(fn);
      return undefined;
    }
    return clock.timers.setTimeout(fn, ms);
  };
  net.request = (opts) =>
    new Promise((resolve, reject) => {
      const payload = JSON.parse(opts.body.toString('utf8'));
      net.attempts += 1;
      let settled = false;
      let connected = false;
      const handles = [];
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        for (const h of handles) clock.timers.clearTimeout(h);
        opts.signal?.removeEventListener('abort', onAbort);
        if (connected) net.open -= 1;
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => {
        if (!connected) finish(new LinkTapError('cancelled'));
        else if (opts.signal.reason === 'cut') finish(new LinkTapError('cut', { sent: true }));
      };
      if (opts.signal?.aborted) {
        finish(new LinkTapError('cancelled'));
        return;
      }
      opts.signal?.addEventListener('abort', onAbort);
      handles.push(
        clock.timers.setTimeout(
          () => finish(new LinkTapError('timeout', { sent: connected })),
          Math.max(0, opts.timeout),
        ),
      );
      if (opts.sendWithin !== undefined) {
        handles.push(
          clock.timers.setTimeout(
            () => {
              if (!connected) finish(new LinkTapError('late'));
            },
            Math.max(0, opts.sendWithin),
          ),
        );
      }
      const connect = () => {
        if (settled) return;
        if (net.down) {
          finish(new LinkTapError('unreachable'));
          return;
        }
        if (opts.beforeSend) {
          try {
            opts.beforeSend();
          } catch (err) {
            err.beforeSend = true;
            err.sent = false;
            finish(err);
            return;
          }
        }
        connected = true;
        net.open += 1;
        net.peak = Math.max(net.peak, net.open);
        opts.onActivity?.();
        if (net.silent) {
          brain.received.push(payload);
          return;
        }
        const answer = brain.handle(payload);
        if (answer === 'silent') return;
        const latency =
          typeof net.latencyMs === 'function' ? net.latencyMs(payload) : net.latencyMs;
        const h = later(latency, () => {
          if (answer?.status !== undefined && answer.raw) {
            finish(null, {
              status: answer.status,
              headers: answer.headers ?? {},
              body: Buffer.from(answer.body ?? ''),
            });
            return;
          }
          finish(null, {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(answer)),
          });
        });
        if (h) handles.push(h);
      };
      const h = later(net.connectMs, connect);
      if (h) handles.push(h);
    });
  return net;
}

/** A raw HTTP answer for `brain.next`. */
export const raw = (status, body = '', headers = {}) => ({ raw: true, status, body, headers });
