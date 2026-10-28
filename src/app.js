// -----------------------------------------------------------------------------
// The integration: the LinkTap gateway (GW-02, GW-01) at the typed address,
// read over its local HTTP API, one Gladys device per water timer, and the
// start / stop / pause commands. index.js only wires the SDK handlers to it
// (src/handlers.js).
//
// One request at a time to a gateway: every request goes through the lane of
// its address (src/linktap/lane.js), stops first.
//
// Reads (never sooner than the interval: not on a reconnection to Gladys, a
// configuration saved again, the Discovery scan, the "Check" button nor after
// a restart, the time of the last read being kept in /data):
//   - cmd 16 (the gateway, its water timers and their names, the volume
//     unit), then cmd 3 for each water timer. The gateway checks its own id in
//     every request: another gateway at the address answers `ret` 3, and is
//     then identified (cmd 3 without ids) as "moved". When the timers are
//     known, a failed cmd 16 never stops the reads of the timers;
//   - a timer the gateway does not know, or whose answer is unreadable, is
//     "not read" without stopping the others; a timer not linked by radio only
//     publishes that;
//   - failures: 30 s, 1, 2, 5 min, never sooner than the interval; HTTP 429 or
//     5xx, or a busy gateway (`ret` 6, 8): a pause of 1 min to 6 h persisted
//     in /data (stops excepted);
//   - a read of an older configuration that ends late publishes nothing.
//
// Commands (buttons, never a switch):
//   - Start: opens a valve, so it is off by default ("Allow starting a
//     watering", taken from the configuration as soon as it is received, and
//     checked on arrival, when its turn comes and right before the request
//     leaves). Decided on a status read just now (already watering: nothing
//     sent). The length is the configured one, 120 minutes at most, carried
//     by the command: the water timer closes by itself at the end. A guard is
//     on disk before the first byte (refused otherwise) and refuses another
//     start of the timer for a minute; a pause or an unreadable /data refuses
//     it. Queued behind other requests at the ack (3.4 s), it may leave within
//     10 s of the click unless a stop of the timer cancels it; when it does
//     not, the status says so.
//   - Stop: never held by the option, a pause, the guards, a missing
//     configuration or a request in flight (it goes ahead of the queue and
//     cuts a request silent for 1 s, or after 1.5 s). It cancels the starts of
//     its timer not sent yet. Not taken (no connection, a busy gateway, an
//     HTTP error): tried again 250 ms later within its 3 s, then every 10 s
//     and at every read reaching the gateway, every minute after 5 minutes,
//     without end until taken (even during a pause and after a restart);
//     never counted. Taken but a read sent after the click still shows the
//     same run watering (4 s after, the radio): sent again, 3 times at most,
//     each counted once. A run proven another one (length, time left grown,
//     younger than the stop) is never stopped; in doubt, the stop wins. The
//     stop guard is never lifted by
//     the time alone (see watchGuards and the docs). Refused unsent only when
//     the timer was never read, or no address of its gateway is known.
//   - Pause of the watering plan (the configured hours): decided on a status
//     read just now; already paused or unknown: nothing sent; a guard refuses
//     a second pause until a read shows the plan paused, 10 min at most (a
//     second pause can switch the plan off, LinkTap issue).
//   - A success is answered only when a read sent after the command shows its
//     effect; otherwise "sent, without confirmation" (then follow-up reads),
//     or "not sent" when nothing left.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, numberOf, parseAddress } from './config.js';
import { BUTTON_PUSH, LIMITS, PAUSE_HOURS, TIMINGS, WATERING_MINUTES } from './constants.js';
import { ERRORS, T, join, kindText, word } from './i18n.js';
import { buildTimerDevice, timerFeatures, timerIds, timerName, valuesOf } from './model.js';
import { StatePublisher } from './publisher.js';
import { FileStore, emptyData } from './store.js';
import { LinkTapClient } from './linktap/client.js';
import { LinkTapError, reasonOf, refusedByGateway } from './linktap/errors.js';
import { GatewayLane, PRIORITY } from './linktap/lane.js';
import { configOf, statusOf } from './linktap/parse.js';

/** A command value, strictly: a finite number or its exact text ('' and null are not 0). */
const strictNumber = (value) => (typeof value === 'boolean' ? undefined : numberOf(value));
const TRANSPORT_KINDS = new Set(['timeout', 'unreachable']);

/** A stop the gateway surely did not apply: not sent, busy, or an HTTP error (404 included). */
const stopNotApplied = (err) =>
  !err.sent || err.kind === 'busy' || err.kind === 'http' || err.kind === 'late';

export class LinkTapApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'linktap' }),
    client = new LinkTapClient(),
    store = new FileStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.config = undefined;
    this.data = undefined;
    this.dataBroken = false;
    this.booting = undefined;
    /** Bumped when the address changes: a late answer of before is dropped. */
    this.generation = 0;
    this.configKey = undefined;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    /** address key -> GatewayLane */
    this.lanes = new Map();
    /** The reads of the typed address: { address, lastTry, next, failures, gatewayId?, error? } (monotonic). */
    this.status = undefined;
    /** No read before this monotonic time (a restart soon after the last read). */
    this.notBefore = 0;
    this.lastTrySaved = -Infinity;
    /** The end of a pause asked by the gateway (monotonic), and its address. */
    this.pauseUntil = undefined;
    /** timerId -> reachable */
    this.reachable = new Map();
    /** [previous id, new id] when another gateway answers at the address */
    this.moved = undefined;
    /** deviceId -> transport badge last published */
    this.transports = new Map();
    /** featureId -> { entry, at (monotonic) }, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** timerId -> the start or pause waiting or running */
    this.pending = new Map();
    /** timerId -> end of its start guard (monotonic) */
    this.startUntil = new Map();
    /** timerId -> request number at the click of the last start / stop (in memory) */
    this.startClick = new Map();
    this.stopClick = new Map();
    /** timerId -> the run seen last ({ total, remain }), and the one seen at the stop */
    this.lastRun = new Map();
    this.stopRun = new Map();
    /** timerId -> when its last stop was clicked (monotonic) */
    this.stopClickAt = new Map();
    /** timerIds whose gateway was seen counting the time left down */
    this.countsDown = new Set();
    /** timerId -> { failures, since, next (monotonic) }: the spaced retries of a stop not taken */
    this.stopRetry = new Map();
    /** timerId -> end of its pause-of-the-plan guard (monotonic) and the number of its request */
    this.planPauseUntil = new Map();
    this.planPauseSeq = new Map();
    /** timerId -> the outcome of a command answered "queued" that did not leave (status) */
    this.notes = new Map();
    /** The configuration last received (applied at once to the commands). */
    this.latest = undefined;
    this.stopTicker = undefined;
    /** timerId -> request number of the last stop that left (in memory) */
    this.stopSeq = new Map();
    /** timerId -> when the gateway took its last stop (monotonic) */
    this.stopTakenAt = new Map();
    /** timerIds whose stop is being sent again */
    this.resending = new Set();
    /** address key -> handles of the follow-ups after the last command */
    this.followUps = new Map();
    /** The read in progress (a poll, a follow-up and the button share it). */
    this.reading = undefined;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.saving = Promise.resolve(true);
    this.lastStatus = undefined;
    this.warned = new Set();
    /** Every request gets a number: a guard is lifted only by a read sent after its command. */
    this.sequence = 0;
    /** The configuration waiting to be applied (the last one saved wins). */
    this.wanted = undefined;
    this.applying = undefined;
    /** `getConfig()` failing: the wait before its next try, in s (status). */
    this.configRetryIn = undefined;
    this.connectRun = 0;
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /**
   * Loads /data once and sends at once the stops that were not taken yet
   * before the restart: no configuration nor read is needed for that.
   */
  boot() {
    if (!this.booting) {
      this.booting = this.doBoot();
    }
    return this.booting;
  }

  async doBoot() {
    let loaded;
    try {
      loaded = await this.store.load();
    } catch {
      loaded = { data: emptyData(), broken: true };
    }
    this.data = loaded.data;
    this.dataBroken = loaded.broken;
    if (this.dataBroken) {
      this.logger.warn('LinkTap: /data/linktap.json cannot be read, nothing will be written to it');
    }
    const now = this.now();
    const mono = this.monotonic();
    if (this.data.pause) {
      this.pauseUntil = mono + Math.min(this.data.pause.until - now, TIMINGS.pauseMax);
    }
    for (const [timerId, guards] of Object.entries(this.data.guards)) {
      if (guards.start) {
        this.startUntil.set(timerId, mono + Math.min(guards.start.until - now, TIMINGS.startGuard));
      }
      if (guards.pause) {
        this.planPauseUntil.set(
          timerId,
          mono + Math.min(guards.pause.until - now, TIMINGS.pauseGuard),
        );
      }
      if (guards.stop && !guards.stop.acked) {
        this.logger.info(`LinkTap ${timerId}: a stop not taken before the restart, sent again`);
        this.resendStop(timerId);
      }
    }
    // A stop not taken yet is tried again every 10 s until it leaves.
    this.stopTicker = this.timers.setInterval(() => this.retryStops(), TIMINGS.stopRetryEvery);
  }

  /** Sends again the stops the gateway has not taken yet (not during their own send). */
  retryStops(gatewayId) {
    if (this.stopped || !this.data) {
      return;
    }
    for (const [timerId, guards] of Object.entries(this.data.guards)) {
      if (
        guards.stop &&
        !guards.stop.acked &&
        !guards.stop.dry &&
        (gatewayId === undefined || guards.gatewayId === gatewayId)
      ) {
        this.resendStop(timerId);
      }
    }
  }

  /** A configuration saved (or read at a connection): applied one at a time, the last one wins. */
  start(raw = {}) {
    // What the commands obey is taken at once: an option unticked holds the
    // starts from now, without waiting for a read or an earlier save.
    this.latest = normalizeConfig(raw);
    if (this.latest.key !== this.configKey) {
      this.configKey = this.latest.key;
      this.generation += 1;
      this.reading = undefined;
    }
    this.wanted = { raw };
    if (!this.applying) {
      this.applying = this.applyLoop().finally(() => {
        this.applying = undefined;
      });
    }
    return this.applying;
  }

  async applyLoop() {
    while (this.wanted) {
      const { raw } = this.wanted;
      this.wanted = undefined;
      await this.applyConfig(raw);
    }
  }

  async applyConfig(raw) {
    await this.boot();
    const first = !this.config;
    this.config = normalizeConfig(raw);
    this.stopped = false;
    if (first && this.data.lastTry !== undefined) {
      // The last read may be later than the one written (once a minute): a
      // whole interval from now is never sooner than the interval.
      if (this.now() - this.data.lastTry < this.interval + TIMINGS.lastTrySave) {
        this.notBefore = this.monotonic() + this.interval;
      }
    }
    if (this.status && this.status.address !== this.config.key) {
      this.status = undefined;
      this.moved = undefined;
    }
    this.refreshCreated();
    this.publisher.start();
    await this.publishDevices();
    await this.publishAllTransports();
    this.schedule();
    this.updateStatus();
    // A read already running is never waited for (a later save applies at once).
    const changed = this.isDue() && !this.reading ? await this.read() : false;
    if (changed) {
      await this.publishDevices();
    }
    this.updateStatus();
  }

  /**
   * The connection to Gladys is up (first time or again): the status and the
   * Discovery tab are published again, nothing old is sent as new. A failing
   * `getConfig()` is tried again without end, spaced, with its status.
   */
  async connected(getConfig) {
    const run = ++this.connectRun;
    this.publisher.reset();
    this.lastStatus = undefined;
    this.transports.clear();
    await this.boot();
    for (let attempt = 0; run === this.connectRun && !this.stopped; attempt += 1) {
      let raw;
      try {
        raw = await getConfig();
      } catch (err) {
        if (run !== this.connectRun) {
          return;
        }
        const wait = TIMINGS.configRetry[Math.min(attempt, TIMINGS.configRetry.length - 1)];
        this.configRetryIn = Math.round(wait / 1000);
        this.logger.warn(
          `Reading the configuration failed (${err?.message ?? 'error'}), next try in ${this.configRetryIn} s`,
        );
        this.updateStatus();
        await this.sleep(wait);
        continue;
      }
      if (run !== this.connectRun) {
        return;
      }
      this.configRetryIn = undefined;
      await this.start(raw);
      return;
    }
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, Math.max(0, ms)));
  }

  async stop() {
    this.stopped = true;
    this.connectRun += 1;
    this.publisher.stop();
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.timers.clearInterval(this.stopTicker);
    this.stopTicker = undefined;
    for (const handles of this.followUps.values()) {
      for (const handle of handles) {
        this.timers.clearTimeout(handle);
      }
    }
    this.followUps.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      await this.save();
    }
    await this.saving;
    for (const lane of this.lanes.values()) {
      lane.clear();
    }
  }

  schedule() {
    this.timers.clearInterval(this.pollTimer);
    // The timer only looks: the gateway is read when due.
    this.pollTimer = this.timers.setInterval(() => this.tick(), Math.min(this.interval, 5000));
  }

  tick() {
    return this.poll()
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${reasonOf(err)}`));
  }

  /** Saves /data now, one write at a time; resolves true when written. */
  save() {
    if (this.dataBroken) {
      return Promise.resolve(false);
    }
    const next = this.saving.then(() =>
      this.store.save(this.data).then(
        () => true,
        () => {
          this.logger.warn('Could not save /data');
          return false;
        },
      ),
    );
    this.saving = next;
    return next;
  }

  persist() {
    if (this.persistTimer || this.dataBroken) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.save();
    }, TIMINGS.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  get gateways() {
    return Object.values(this.data?.gateways ?? {});
  }

  nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  laneOf(address) {
    if (!this.lanes.has(address)) {
      this.lanes.set(
        address,
        new GatewayLane({
          monotonic: this.monotonic,
          timers: this.timers,
          stallCut: TIMINGS.stallCut,
          protectiveWait: TIMINGS.protectiveWait,
        }),
      );
    }
    return this.lanes.get(address);
  }

  /** One request through the lane of an address. */
  request(address, priority, call, { signal } = {}) {
    const target = parseAddress(address);
    if (!target) {
      return Promise.reject(new LinkTapError('unreachable'));
    }
    return this.laneOf(address).run((context) => call(target, context), { priority, signal });
  }

  // --- Pauses (429, 5xx, busy) -----------------------------------------------

  paused(address = this.config?.key) {
    const pause = this.data?.pause;
    if (!pause || pause.address !== address || this.pauseUntil === undefined) {
      return false;
    }
    // Capped at every use: a clock that jumps never makes it longer.
    const left = Math.min(this.pauseUntil - this.monotonic(), TIMINGS.pauseMax);
    return left > 0;
  }

  /** A failure: a pause asked by the gateway is persisted. */
  onFailure(address, err) {
    if (!(err instanceof LinkTapError) || err.kind !== 'busy' || !address) {
      return;
    }
    const previous = this.data.pause?.address === address ? this.data.pause : undefined;
    const failures = previous ? previous.failures + 1 : 1;
    const asked = err.retryAfter ?? TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10);
    const wait = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, asked));
    this.logger.warn(`LinkTap: ${err.message}, paused for ${Math.round(wait / 1000)} s`);
    this.data.pause = { address, failures, until: this.now() + wait };
    this.pauseUntil = this.monotonic() + wait;
    this.persist();
    this.updateStatus();
  }

  onSuccess(address) {
    if (this.data.pause?.address === address) {
      this.data.pause = undefined;
      this.pauseUntil = undefined;
      this.persist();
    }
  }

  // --- Reads -----------------------------------------------------------------

  statusOf() {
    if (!this.status) {
      this.status = { address: this.config.key, lastTry: undefined, next: 0, failures: 0 };
    }
    return this.status;
  }

  /** Whether a read is due (never sooner than the interval, a backoff or a pause). */
  isDue() {
    if (!this.config?.address || this.stopped) {
      return false;
    }
    const mono = this.monotonic();
    if (mono < this.notBefore || this.paused()) {
      return false;
    }
    const status = this.status;
    return !status || status.lastTry === undefined || mono >= status.next;
  }

  /** The time of the last read, written to /data at most once a minute. */
  markTry() {
    this.data.lastTry = this.now();
    const mono = this.monotonic();
    if (mono - this.lastTrySaved >= TIMINGS.lastTrySave) {
      this.lastTrySaved = mono;
      this.persist();
    }
  }

  /** One read when due; true when a Gladys device changes. */
  async poll() {
    if (!this.isDue()) {
      return this.reading ?? false;
    }
    return this.read();
  }

  /** Reads the gateway; a read already running is shared. */
  read() {
    if (this.reading) {
      return this.reading;
    }
    const promise = this.doRead(this.generation).finally(() => {
      if (this.reading === promise) {
        this.reading = undefined;
      }
    });
    this.reading = promise;
    return promise;
  }

  /** The gateway known at an address. */
  gatewayAt(address) {
    return this.gateways.find((g) => g.address === address);
  }

  async doRead(generation) {
    const address = this.config.key;
    const status = this.statusOf();
    status.lastTry = this.monotonic();
    // Written before the read: a crash during it never reads sooner after.
    this.markTry();
    const stale = () => generation !== this.generation || this.stopped;
    const fail = (err) => {
      if (stale()) {
        return false;
      }
      this.onFailure(address, err);
      this.failed(status, err?.kind ?? 'error');
      this.logger.debug(`Read failed: ${reasonOf(err)}`);
      return false;
    };
    const read = (call) =>
      this.request(address, PRIORITY.READ, (target, context) =>
        call(target, {
          timeout: TIMINGS.requestTimeout,
          signal: context.signal,
          onActivity: context.activity,
        }),
      );
    let gateway = this.gatewayAt(address);
    let config;
    let configTransport;
    try {
      if (!gateway) {
        const id = await read((target, options) => this.client.probe(target, options));
        if (stale()) return false;
        gateway = this.adopt(id, address);
      }
      try {
        config = configOf(
          await read((target, options) => this.client.config(target, gateway.id, options)),
        );
      } catch (err) {
        if (stale()) return false;
        if (err.kind === 'otherGateway') {
          // Another gateway at the address: identified, the known one has moved.
          const id = await read((target, options) => this.client.probe(target, options));
          if (stale()) return false;
          if (id === gateway.id) {
            throw new LinkTapError('invalid', { sent: true });
          }
          gateway = this.adopt(id, address);
          config = configOf(
            await read((target, options) => this.client.config(target, gateway.id, options)),
          );
        } else if (err.kind === 'busy' || gateway.timers.length === 0) {
          throw err;
        } else {
          // The timers are known: the configuration is secondary. A transport
          // failure stops the read only if the first timer fails the same way.
          configTransport = TRANSPORT_KINDS.has(err.kind) ? err : undefined;
          this.logger.debug(`Gateway configuration not read: ${reasonOf(err)}`);
        }
      }
    } catch (err) {
      if (err.kind === 'invalid' && !stale()) {
        this.failed(status, 'notGateway');
        return false;
      }
      return fail(err);
    }
    if (stale()) {
      return false;
    }
    let changed = config ? this.remember(gateway, config) : false;
    let readCount = 0;
    let missed = 0;
    for (const timer of [...gateway.timers]) {
      let reading;
      const origin = { seq: 0 };
      try {
        reading = statusOf(
          await this.request(address, PRIORITY.READ, (target, context) => {
            origin.seq = this.nextSequence();
            return this.client.status(target, gateway.id, timer.id, {
              timeout: TIMINGS.requestTimeout,
              signal: context.signal,
              onActivity: context.activity,
            });
          }),
          timer.id,
          gateway.volumeUnit,
        );
      } catch (err) {
        if (stale()) return false;
        if (err.kind === 'cut') {
          continue;
        }
        if (
          err.kind === 'unreachable' ||
          err.kind === 'busy' ||
          err.kind === 'otherGateway' ||
          (configTransport && readCount === 0 && missed === 0 && TRANSPORT_KINDS.has(err.kind))
        ) {
          // The gateway itself: the read stops here.
          return fail(err);
        }
        missed += 1;
        this.setReachable(timer.id, false);
        this.logger.debug(`LinkTap ${timer.id} not read: ${reasonOf(err)}`);
        continue;
      }
      if (stale()) {
        return false;
      }
      if (!reading) {
        missed += 1;
        this.setReachable(timer.id, false);
        continue;
      }
      readCount += 1;
      if (reading.flowMeter === true && !timer.flowMeter) {
        timer.flowMeter = true;
        changed = true;
        this.persist();
      }
      this.handleReading(gateway, timer, reading, origin);
    }
    this.onSuccess(address);
    status.failures = 0;
    status.next = status.lastTry + this.interval;
    status.error = undefined;
    status.gatewayId = gateway.id;
    status.read = readCount;
    status.missed = missed;
    this.rememberRead({ ok: true, gatewayId: gateway.id, address, at: this.now() });
    // The gateway answers: the stops it has not taken yet go now.
    this.retryStops(gateway.id);
    return changed;
  }

  /** The record of the gateway `id` answering at `address` (created, or moved here). */
  adopt(id, address) {
    const gateways = this.data.gateways;
    let record = gateways[id];
    for (const other of this.gateways) {
      if (other.id !== id && other.address === address) {
        this.logger.warn(`LinkTap gateway ${other.id} no longer answers, ${id} does`);
        this.moved = [other.id, id];
        other.address = '';
        for (const timer of other.timers) {
          this.setReachable(timer.id, false);
        }
      }
    }
    if (!record) {
      if (Object.keys(gateways).length >= LIMITS.gateways) {
        const oldest = this.gateways.find((g) => g.address !== address);
        if (oldest) delete gateways[oldest.id];
      }
      record = { id, address, version: '', timers: [] };
      gateways[id] = record;
    } else if (record.address !== address) {
      this.logger.info(`LinkTap gateway ${id} answers at a new address`);
      record.address = address;
    }
    if (this.moved && this.moved[0] === id) {
      this.moved = undefined;
    }
    this.persist();
    return record;
  }

  /** The configuration read (cmd 16) kept; a timer no longer listed keeps its device. */
  remember(gateway, config) {
    const before = JSON.stringify(gateway);
    if (config.version) gateway.version = config.version;
    if (config.volumeUnit) gateway.volumeUnit = config.volumeUnit;
    if (config.timers) {
      const byId = new Map(gateway.timers.map((t) => [t.id, t]));
      for (const timer of config.timers) {
        const known = byId.get(timer.id);
        if (known) {
          known.name = timer.name || known.name;
        } else if (byId.size < LIMITS.timers) {
          const added = { id: timer.id, name: timer.name };
          byId.set(timer.id, added);
          gateway.timers.push(added);
        }
      }
    }
    const changed = JSON.stringify(gateway) !== before;
    if (changed) {
      this.persist();
    }
    return changed;
  }

  /** The outcome of the last read, kept in /data with lastTry (the status after a restart). */
  rememberRead(outcome) {
    const previous = this.data.lastRead;
    this.data.lastRead = outcome;
    if (previous?.ok !== outcome.ok || previous?.gatewayId !== outcome.gatewayId) {
      this.persist();
    }
  }

  failed(status, error) {
    status.failures += 1;
    status.error = error;
    status.gatewayId = undefined;
    this.rememberRead({ ok: false, address: status.address, at: this.now() });
    const wait = TIMINGS.backoff[Math.min(status.failures, TIMINGS.backoff.length) - 1];
    status.next = status.lastTry + Math.max(wait, this.interval);
    const gateway = this.gatewayAt(status.address);
    for (const timer of gateway?.timers ?? []) {
      this.setReachable(timer.id, false);
    }
  }

  /** A reading of a timer: guards, values, badge. */
  handleReading(gateway, timer, reading, origin) {
    const linked = reading.rfLinked !== false;
    this.setReachable(timer.id, linked);
    this.recordValues(timer, reading);
    if (linked) {
      this.watchGuards(gateway, timer.id, reading, origin);
      if (reading.watering) {
        const previous = this.lastRun.get(timer.id);
        if (
          previous &&
          previous.total === reading.total &&
          reading.remaining !== undefined &&
          previous.remain !== undefined &&
          reading.remaining < previous.remain
        ) {
          // The gateway counts the time left down: the age of a run can be trusted.
          this.countsDown.add(timer.id);
        }
        this.lastRun.set(timer.id, { total: reading.total, remain: reading.remaining });
      } else {
        this.lastRun.delete(timer.id);
      }
    }
  }

  /**
   * A watering read after a stop is another run (started elsewhere) than the
   * one stopped, on proof only (in doubt, the stop wins):
   *   - its length differs from the run seen at the stop;
   *   - its time left grew past the last one seen of the stopped run;
   *   - it is younger than the time since the click: its elapsed time
   *     (length - time left) is shorter than the time since the click, less
   *     a margin; only once this gateway was seen counting the time left
   *     down (a time left that does not move proves nothing).
   */
  isNewRun(timerId, reading) {
    const run = this.stopRun.get(timerId);
    if (!run || run.total === undefined || reading.total === undefined) {
      return false;
    }
    if (reading.total !== run.total) {
      return true;
    }
    if (reading.remaining === undefined) {
      return false;
    }
    if (run.remain !== undefined && reading.remaining > run.remain + TIMINGS.runTolerance) {
      return true;
    }
    const clickAt = this.stopClickAt.get(timerId);
    if (!this.countsDown.has(timerId) || clickAt === undefined) {
      return false;
    }
    const elapsed = reading.total - reading.remaining;
    const since = (this.monotonic() - clickAt) / 1000;
    return elapsed < since - TIMINGS.runAgeMargin;
  }

  /**
   * The guards of a timer against a reading sent after their click (request
   * numbers; after a restart, any reading):
   *   - start guard: lifted by the timer seen watering;
   *   - pause guard: lifted by the plan seen paused;
   *   - stop guard, before a dry reading: the run seen at the stop still
   *     watering -> the stop is sent again (3 times at most, never while its
   *     own send is out); another run (its length changed, or its time left
   *     grew: started by the app, the button or the plan) read twice in a row
   *     lifts the guard; dry -> "dry", kept;
   *   - stop guard, dry: a watering read twice in a row was started elsewhere:
   *     the guard is lifted.
   */
  watchGuards(gateway, timerId, reading, origin) {
    const guards = this.data.guards[timerId];
    if (!guards) {
      return;
    }
    const watering = reading.watering;
    const after = (...seqs) => origin.seq > Math.max(-1, ...seqs.filter((n) => n !== undefined));
    if (guards.start && watering && after(guards.startSeq, this.startClick.get(timerId))) {
      this.liftStart(timerId);
    }
    if (guards.pause && reading.paused === true && after(this.planPauseSeq.get(timerId))) {
      this.liftPause(timerId);
    }
    const stop = guards.stop;
    if (!stop || !after(this.stopSeq.get(timerId), this.stopClick.get(timerId))) {
      return;
    }
    if (!watering) {
      if (!stop.dry || stop.seenWatering > 0) {
        stop.dry = true;
        stop.seenWatering = 0;
        this.persist();
        this.updateStatus();
      }
      return;
    }
    if (stop.dry || this.isNewRun(timerId, reading)) {
      // Started elsewhere: lifted when seen twice in a row.
      stop.seenWatering += 1;
      if (stop.seenWatering >= 2) {
        this.logger.info(`LinkTap ${timerId}: watering started elsewhere, stop guard lifted`);
        delete guards.stop;
        this.stopRun.delete(timerId);
        this.cleanGuards(timerId);
      }
      this.persist();
      return;
    }
    stop.seenWatering = 0;
    if (!this.stopRun.has(timerId) && reading.total !== undefined) {
      this.stopRun.set(timerId, { total: reading.total, remain: reading.remaining });
    } else if (this.stopRun.has(timerId) && reading.remaining !== undefined) {
      this.stopRun.get(timerId).remain = reading.remaining;
    }
    if (
      !stop.acked ||
      this.monotonic() - (this.stopTakenAt.get(timerId) ?? -Infinity) >= TIMINGS.radioDelay
    ) {
      // Taken by the gateway a moment ago: the radio may not have carried it yet.
      this.resendStop(timerId);
    }
  }

  cleanGuards(timerId) {
    const guards = this.data.guards[timerId];
    if (guards && !guards.start && !guards.stop && !guards.pause) {
      delete this.data.guards[timerId];
    }
  }

  liftStart(timerId) {
    const guards = this.data.guards[timerId];
    this.startUntil.delete(timerId);
    if (guards?.start) {
      delete guards.start;
      delete guards.startSeq;
      this.cleanGuards(timerId);
      this.persist();
    }
  }

  liftPause(timerId) {
    const guards = this.data.guards[timerId];
    this.planPauseUntil.delete(timerId);
    this.planPauseSeq.delete(timerId);
    if (guards?.pause) {
      delete guards.pause;
      this.cleanGuards(timerId);
      this.persist();
    }
  }

  recordValues(timer, reading) {
    const at = this.monotonic();
    for (const [featureId, entry] of valuesOf(this.gladys, timer, reading)) {
      this.lastValues.set(featureId, { entry, at });
      if (this.created.has(featureId)) {
        this.publisher.push(featureId, entry);
      }
    }
  }

  setReachable(timerId, reachable) {
    const previous = this.reachable.get(timerId);
    this.reachable.set(timerId, reachable);
    if (previous !== reachable) {
      this.publishTransportsOf(timerId).catch((err) =>
        this.logger.warn(`Transport badge failed: ${reasonOf(err)}`),
      );
    }
  }

  // --- Gladys devices ----------------------------------------------------------

  /**
   * The Discovery tab. A created device never loses a feature: the features
   * it has that the code no longer gives are published as they are.
   */
  async publishDevices() {
    const devices = [];
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const gateway of this.gateways) {
      for (const timer of gateway.timers) {
        const device = buildTimerDevice(this.gladys, gateway, timer, {
          language: this.config?.language ?? 'fr',
        });
        const published = new Set(device.features.map((f) => f.external_id));
        for (const feature of created.get(device.external_id)?.features ?? []) {
          if (!published.has(feature.external_id)) {
            const kept = {};
            for (const field of [
              'name',
              'external_id',
              'category',
              'type',
              'min',
              'max',
              'unit',
              'read_only',
              'has_feedback',
              'keep_history',
            ]) {
              if (feature[field] !== undefined && feature[field] !== null) {
                kept[field] = feature[field];
              }
            }
            device.features.push(kept);
          }
        }
        devices.push(device);
      }
    }
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) =>
        this.logger.warn(`Publishing the discovered devices failed: ${reasonOf(err)}`),
      );
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  /** A device created or updated: its fresh values only (never an old one sent as new). */
  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    const fresh = 2 * (this.config ? this.interval : TIMINGS.backoff.at(-1));
    for (const feature of device?.features ?? []) {
      const value = this.lastValues.get(feature.external_id);
      if (value && this.monotonic() - value.at <= fresh) {
        this.publisher.push(feature.external_id, value.entry);
      }
    }
    const timer = this.findTimerByDevice(device?.external_id);
    if (timer) {
      await this.publishTransportsOf(timer.timer.id).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  findTimerByDevice(deviceId) {
    for (const gateway of this.gateways) {
      for (const timer of gateway.timers) {
        if (timerIds(this.gladys, timer.id).device === deviceId) {
          return { gateway, timer };
        }
      }
    }
    return undefined;
  }

  /** The timer and the feature key of a feature external id (from /data: no configuration needed). */
  findFeature(featureId) {
    if (typeof featureId !== 'string') {
      return undefined;
    }
    for (const gateway of this.gateways) {
      for (const timer of gateway.timers) {
        const ids = timerIds(this.gladys, timer.id);
        if (featureId.startsWith(`${ids.device}:`)) {
          const key = featureId.slice(ids.device.length + 1);
          if (timerFeatures({ flowMeter: true }).some((f) => f.key === key)) {
            return { gateway, timer, key };
          }
        }
      }
    }
    return undefined;
  }

  async publishTransportsOf(timerId) {
    const created = this.createdDevices();
    const device = timerIds(this.gladys, timerId).device;
    if (!created.has(device) || !this.reachable.has(timerId)) {
      return;
    }
    const transport = this.reachable.get(timerId)
      ? DEVICE_TRANSPORTS.LOCAL
      : DEVICE_TRANSPORTS.UNREACHABLE;
    if (this.transports.get(device) === transport) {
      return;
    }
    this.transports.set(device, transport);
    await this.gladys.publishTransports([{ external_id: device, transport }]);
  }

  async publishAllTransports() {
    const created = this.createdDevices();
    const entries = [];
    for (const [timerId, reachable] of this.reachable) {
      const device = timerIds(this.gladys, timerId).device;
      const transport = reachable ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
      if (created.has(device) && this.transports.get(device) !== transport) {
        this.transports.set(device, transport);
        entries.push({ external_id: device, transport });
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries.slice(0, 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${reasonOf(err)}`));
    }
  }

  /** The stop guards whose timer a read still shows watering (status). */
  stopsNotTaken(pending = false) {
    const names = [];
    for (const [timerId, guards] of Object.entries(this.data?.guards ?? {})) {
      const stop = guards.stop;
      if (
        stop &&
        !stop.dry &&
        (pending ? !stop.acked : stop.acked && stop.resends >= TIMINGS.stopResends)
      ) {
        const timer = this.gateways.flatMap((g) => g.timers).find((t) => t.id === timerId);
        names.push(timer ? timerName(timer) : timerId);
      }
    }
    return names;
  }

  updateStatus() {
    if (!this.data) {
      return;
    }
    const parts = [];
    let connected = false;
    if (this.configRetryIn !== undefined) {
      parts.push(T.configUnreadable(this.configRetryIn));
    } else if (!this.config) {
      return;
    } else if (!this.config.address) {
      parts.push(
        this.config.invalidAddress ? T.invalidAddress(this.config.invalidAddress) : T.noAddress,
      );
    } else {
      const status = this.status;
      if (status?.lastTry !== undefined) {
        const gateway = status.gatewayId ? this.data.gateways[status.gatewayId] : undefined;
        // Every timer failing is not "connected".
        connected = Boolean(gateway) && !(status.read === 0 && status.missed > 0);
        if (gateway && !connected) {
          parts.push(T.noTimerRead);
        } else if (gateway) {
          const watering = gateway.timers.filter(
            (t) =>
              this.lastValues.get(timerIds(this.gladys, t.id).feature('watering'))?.entry.state ===
              1,
          ).length;
          parts.push(T.ok(gateway.id, gateway.timers.length, watering));
          if (status.missed > 0) {
            parts.push(T.timersUnreachable(status.missed));
          }
        } else if (status.error === 'notGateway') {
          parts.push(T.notGateway);
        } else {
          parts.push(T.failed(status.error ?? 'error'));
        }
      } else {
        // After a restart, before the first read (never sooner than the
        // interval): the outcome of the last read kept in /data.
        const last = this.data.lastRead;
        connected = Boolean(last?.ok && last.address === this.config.key);
        parts.push(connected ? T.restored(this.config.pollInterval) : T.waiting);
      }
      if (this.paused()) {
        parts.push(T.paused);
      }
      if (this.moved) {
        parts.push(T.moved(this.moved[0], this.moved[1]));
      }
      if (!this.config.allowWatering) {
        parts.push(T.wateringOff);
      }
    }
    for (const [timerId, note] of this.notes) {
      // An outcome is told for half an hour at most (or until the next command).
      if (this.monotonic() - note.at > TIMINGS.noteLife) {
        this.notes.delete(timerId);
      } else {
        parts.push(note.text);
      }
    }
    const waiting = this.stopsNotTaken(true);
    if (waiting.length > 0) {
      parts.push(T.stopPending(waiting.join(', ').slice(0, 200)));
    }
    const notTaken = this.stopsNotTaken();
    if (notTaken.length > 0) {
      parts.push(T.stopUnconfirmed(notTaken.join(', ').slice(0, 200)));
    }
    if (this.dataBroken) {
      parts.push(T.dataBroken);
    }
    const message = join(parts);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${reasonOf(err)}`));
  }

  /** The Discovery tab scan: a read only when due, then the devices. */
  async scan() {
    await this.boot();
    if (!this.config) {
      return;
    }
    await this.poll();
    await this.publishDevices();
    this.updateStatus();
  }

  /** "Check the gateway": what it answered, read again only when due. */
  async checkGateway() {
    await this.boot();
    if (!this.config?.address) {
      return T.check.none;
    }
    if (await this.poll()) {
      await this.publishDevices();
    }
    this.updateStatus();
    const status = this.status;
    const lines = [];
    if (!status || status.lastTry === undefined) {
      lines.push(T.check.pending);
    } else {
      const age = Math.max(0, Math.round((this.monotonic() - status.lastTry) / 1000));
      const gateway = status.gatewayId ? this.data.gateways[status.gatewayId] : undefined;
      lines.push(
        gateway
          ? T.check.ok(gateway.id, gateway.version, gateway.timers.length, age)
          : status.error === 'notGateway'
            ? T.notGateway
            : T.check.failed(status.error ?? 'error', age),
      );
    }
    if (this.paused()) {
      lines.push(T.paused);
    }
    lines.push(T.check.interval(this.config.pollInterval));
    return join(lines, '\n');
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.latest?.language ?? this.config?.language ?? 'fr'));
    error.refusal = true;
    error.text = text;
    return error;
  }

  get language() {
    return this.latest?.language ?? this.config?.language ?? 'fr';
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    await this.boot();
    const target = this.findFeature(feature?.external_id);
    if (!target) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (!['start', 'stop', 'pause_plan'].includes(target.key)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (strictNumber(value) !== BUTTON_PUSH.PRESSED) {
      throw this.refusal(ERRORS.badValue);
    }
    // A new command of the timer: the outcome of the previous one leaves the status.
    if (this.notes.delete(target.timer.id)) {
      this.updateStatus();
    }
    if (target.key === 'stop') {
      return this.stopCommand(target.gateway, target.timer, received);
    }
    if (target.key === 'start') {
      return this.startCommand(target.gateway, target.timer, received);
    }
    return this.pauseCommand(target.gateway, target.timer, received);
  }

  /**
   * The checks every start makes on arrival, at its turn and right before it
   * leaves, against the configuration last received (applied at once).
   */
  checkStart(gateway, timer, ticket, received) {
    const config = this.latest;
    if (ticket?.cancelled) throw this.refusal(ERRORS.cancelled);
    if (ticket && ticket.generation !== this.generation) throw this.refusal(ERRORS.configChanged);
    if (!config?.allowWatering) throw this.refusal(ERRORS.wateringDisabled);
    if (this.dataBroken) throw this.refusal(ERRORS.dataBroken);
    if (
      !gateway.address ||
      gateway.address !== config.key ||
      this.data.gateways[gateway.id] !== gateway ||
      !gateway.timers.includes(timer)
    ) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.paused(config.key)) throw this.refusal(ERRORS.blocked);
    if (this.monotonic() > received + TIMINGS.commandQueueMax) throw this.refusal(ERRORS.tooSlow);
  }

  /** Answers a command at its ack time: its outcome if known, "queued" or "sent" otherwise. */
  async ackOf(outcome, received, ticket) {
    let timer;
    const ack = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve({ late: true }),
        Math.max(0, received + TIMINGS.ackBy - this.monotonic()),
      );
    });
    const result = await Promise.race([outcome, ack]);
    this.timers.clearTimeout(timer);
    if (result.late) {
      // The outcome is told in the status if it is not the one hoped for.
      ticket.acked = true;
      throw this.refusal(
        ticket.sent ? ERRORS.sentUnconfirmed(word(ERRORS.noAnswer, this.language)) : ERRORS.queued,
      );
    }
    return result;
  }

  /** A command answered "queued" that did not leave (or was refused): said in the status. */
  noteLate(timer, kind, err) {
    // A whole sentence in both languages: the refusal, or "Not sent (…)" / "Refused (…)".
    const of = (make) => ({
      en: make(kindText(err.kind).en).en,
      fr: make(kindText(err.kind).fr).fr,
    });
    const reason = err.text ?? (kind === 'refused' ? of(ERRORS.refused) : of(ERRORS.notSent));
    this.notes.set(timer.id, {
      text: T.lateOutcome(timerName(timer), kind, reason),
      at: this.monotonic(),
    });
    // The real state again, in case a dashboard showed what was hoped for.
    const featureId = timerIds(this.gladys, timer.id).feature('watering');
    const last = this.lastValues.get(featureId);
    if (last && this.created.has(featureId)) {
      this.gladys.forgetPublishedStates(featureId);
      this.publisher.push(featureId, last.entry);
    }
    this.updateStatus();
  }

  // --- Start (a valve opens: off by default) ---------------------------------

  async startCommand(gateway, timer, received) {
    this.checkStart(gateway, timer, undefined, received);
    if (this.pending.has(timer.id)) {
      throw this.refusal(ERRORS.pending);
    }
    const until = this.startUntil.get(timer.id);
    if (until !== undefined && Math.min(until - this.monotonic(), TIMINGS.startGuard) > 0) {
      throw this.refusal(ERRORS.justStarted);
    }
    const ticket = {
      kind: 'start',
      cancelled: false,
      sent: false,
      acked: false,
      generation: this.generation,
      abort: new AbortController(),
    };
    this.pending.set(timer.id, ticket);
    this.startClick.set(timer.id, this.nextSequence());
    const release = () => {
      if (this.pending.get(timer.id) === ticket) {
        this.pending.delete(timer.id);
      }
    };
    // The guard is on disk before the first byte, or nothing leaves.
    const guards = this.data.guards[timer.id] ?? { gatewayId: gateway.id };
    guards.gatewayId = gateway.id;
    guards.start = { at: this.now(), until: this.now() + TIMINGS.startGuard };
    delete guards.startSeq;
    this.data.guards[timer.id] = guards;
    this.startUntil.set(timer.id, this.monotonic() + TIMINGS.startGuard);
    if (!(await this.save())) {
      this.liftStart(timer.id);
      release();
      throw this.refusal(ERRORS.saveFailed);
    }
    const outcome = (async () => {
      // Decided on the state read just now (after the click): a timer not
      // linked by radio or unreadable is refused, one already watering is
      // left as it is (nothing sent, its run never lengthened).
      const origin = { seq: 0 };
      let reading;
      try {
        reading = statusOf(
          await this.request(
            gateway.address,
            PRIORITY.COMMAND,
            (target, context) => {
              this.checkStart(gateway, timer, ticket, received);
              origin.seq = this.nextSequence();
              return this.client.status(target, gateway.id, timer.id, {
                timeout: TIMINGS.requestTimeout,
                signal: context.signal,
                onActivity: context.activity,
              });
            },
            { signal: ticket.abort.signal },
          ),
          timer.id,
          gateway.volumeUnit,
        );
      } catch (err) {
        if (err.refusal || err.kind === 'cancelled') throw err;
        this.onFailure(gateway.address, err);
        throw this.refusal(ERRORS.unknownState);
      }
      if (!reading || reading.rfLinked === false) {
        throw this.refusal(ERRORS.unknownState);
      }
      this.handleReading(gateway, timer, reading, origin);
      if (reading.watering) {
        // The click asks for watering: a stop still watched no longer is.
        this.checkStart(gateway, timer, ticket, received);
        if (guards.stop) {
          delete guards.stop;
          this.persist();
        }
        return { ok: true, nothing: true };
      }
      // The length, from the configuration last received, capped here too.
      const minutes = Math.min(
        WATERING_MINUTES.max,
        Math.max(WATERING_MINUTES.min, this.latest.wateringMinutes),
      );
      await this.request(
        gateway.address,
        PRIORITY.SEND,
        (target, context) => {
          this.checkStart(gateway, timer, ticket, received);
          this.logger.info(`LinkTap ${timer.id}: start for ${minutes} min`);
          return this.client.start(target, gateway.id, timer.id, minutes * 60, {
            timeout: TIMINGS.requestTimeout,
            sendWithin: received + TIMINGS.commandQueueMax - this.monotonic(),
            signal: context.signal,
            onActivity: context.activity,
            // The very last check, right before the request leaves.
            beforeSend: () => {
              this.checkStart(gateway, timer, ticket, received);
              ticket.sent = true;
              guards.startSeq = this.nextSequence();
              // A newer start from Gladys: the stop guard of the timer is lifted.
              if (guards.stop) {
                delete guards.stop;
                this.persist();
              }
            },
          });
        },
        { signal: ticket.abort.signal },
      );
      return { ok: true };
    })().then(
      (result) => result,
      (err) => ({ err }),
    );
    // Settled in the background too (the ack may come first).
    const settled = outcome.then((result) => {
      release();
      if (result.nothing) {
        // Already watering: nothing sent, the guard goes.
        this.liftStart(timer.id);
        return result;
      }
      if (result.ok) {
        this.followUp(gateway);
        return result;
      }
      const err = result.err;
      if (err.refusal || err.beforeSend || !err.sent) {
        // Surely nothing left: the guard goes.
        this.liftStart(timer.id);
        if (!err.refusal)
          this.logger.warn(`LinkTap ${timer.id}: start NOT sent (${reasonOf(err)})`);
        if (ticket.acked) this.noteLate(timer, 'notSent', err);
      } else if (refusedByGateway(err)) {
        this.onFailure(gateway.address, err);
        this.liftStart(timer.id);
        this.logger.warn(`LinkTap ${timer.id}: start refused (${reasonOf(err)})`);
        if (ticket.acked) this.noteLate(timer, 'refused', err);
      } else {
        this.onFailure(gateway.address, err);
        this.followUp(gateway);
        this.logger.warn(`LinkTap ${timer.id}: start sent, NOT confirmed (${reasonOf(err)})`);
      }
      return result;
    });
    const result = await this.ackOf(settled, received, ticket);
    if (!result.ok) {
      const err = result.err;
      if (err.refusal) throw err;
      if (err.kind === 'cancelled' || ticket.cancelled) throw this.refusal(ERRORS.cancelled);
      if (err.beforeSend || !err.sent) {
        throw this.refusal(
          err.kind === 'late'
            ? ERRORS.tooSlow
            : ERRORS.notSent(word(kindText(err.kind), this.language)),
        );
      }
      if (refusedByGateway(err)) {
        throw this.refusal(ERRORS.refused(word(kindText(err.kind), this.language)));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(word(kindText(err.kind), this.language)));
    }
    if (result.nothing) {
      return;
    }
    // Confirmed only by a read sent after it showing the timer watering.
    const confirmed = await this.confirm(
      gateway,
      timer,
      received,
      (reading) => reading.watering === true,
    );
    if (!confirmed) {
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.language)));
    }
  }

  /**
   * A read of the timer after a command (the radio gets `confirmDelay` to
   * carry it), within the ack: true when `wanted(reading)`. It feeds the
   * guards and the values like any read. Not sent in time: dropped from the
   * queue, never sent for nothing.
   */
  async confirm(gateway, timer, received, wanted) {
    const ackAt = received + TIMINGS.ackBy;
    const readAt = this.monotonic() + TIMINGS.confirmDelay;
    if (ackAt - readAt < 400 || this.paused(gateway.address)) {
      return false;
    }
    await this.sleep(TIMINGS.confirmDelay);
    const origin = { seq: 0 };
    const abort = new AbortController();
    try {
      const json = await Promise.race([
        this.request(
          gateway.address,
          PRIORITY.COMMAND,
          (target, context) => {
            origin.seq = this.nextSequence();
            return this.client.status(target, gateway.id, timer.id, {
              timeout: Math.max(100, ackAt - this.monotonic() - 100),
              signal: context.signal,
              onActivity: context.activity,
            });
          },
          { signal: abort.signal },
        ),
        this.sleep(Math.max(0, ackAt - this.monotonic() - 50)).then(() => undefined),
      ]);
      const reading = json && statusOf(json, timer.id, gateway.volumeUnit);
      if (!reading || reading.rfLinked === false) {
        return false;
      }
      this.handleReading(gateway, timer, reading, origin);
      return wanted(reading);
    } catch {
      return false;
    } finally {
      // Still queued: dropped (once connected, a request is never aborted this way).
      abort.abort();
    }
  }

  // --- Stop (protective: never held) -----------------------------------------

  /** Cancels the starts of a timer not sent yet (queued ones included). */
  cancelStarts(timerId) {
    const ticket = this.pending.get(timerId);
    if (ticket?.kind === 'start' && !ticket.sent) {
      ticket.cancelled = true;
      ticket.abort.abort();
    }
  }

  async stopCommand(gateway, timer, received) {
    // On arrival, before anything else: the start waiting is cancelled.
    this.cancelStarts(timer.id);
    if (!gateway.address) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    // Only a reading sent after this click decides for this stop.
    this.stopClick.set(timer.id, this.nextSequence());
    this.stopClickAt.set(timer.id, this.monotonic());
    this.stopRetry.delete(timer.id);
    const run = this.lastRun.get(timer.id);
    if (run) {
      this.stopRun.set(timer.id, { ...run });
    } else {
      this.stopRun.delete(timer.id);
    }
    const guards = this.data.guards[timer.id] ?? { gatewayId: gateway.id };
    guards.gatewayId = gateway.id;
    guards.stop = { at: this.now(), acked: false, dry: false, resends: 0, seenWatering: 0 };
    this.data.guards[timer.id] = guards;
    // No resend while the stop of the click is out (the write of /data included).
    this.resending.add(timer.id);
    let outcome;
    try {
      // On disk if it can be within 300 ms: a stop never waits for /data.
      await Promise.race([this.save(), this.sleep(300)]);
      outcome = await this.sendStop(
        gateway,
        timer.id,
        received + TIMINGS.stopSendBy,
        received + TIMINGS.ackBy - 100,
      );
    } finally {
      this.resending.delete(timer.id);
    }
    this.followUp(gateway);
    if (outcome.error) {
      throw outcome.error;
    }
    const confirmed = await this.confirm(
      gateway,
      timer,
      received,
      (reading) => reading.watering === false,
    );
    if (!confirmed) {
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.language)));
    }
  }

  /**
   * Sends the stop of a timer, ahead of the queue; tried again once 250 ms
   * later when the gateway did not take it, within `sendBy`, as long as its
   * guard is the same. Resolves `{ sent, taken, error }`, never rejects.
   */
  async sendStop(gateway, timerId, sendBy, answerBy) {
    const address = gateway.address;
    const guard = this.data.guards[timerId]?.stop;
    let last;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0 && this.data.guards[timerId]?.stop !== guard) {
        // A newer start or stop took over: this one is not sent again.
        return { sent: false, error: this.refusal(ERRORS.cancelled) };
      }
      try {
        await this.request(address, PRIORITY.PROTECTIVE, (target, context) =>
          this.client.stop(target, gateway.id, timerId, {
            timeout: Math.max(300, answerBy - this.monotonic()),
            sendWithin: sendBy - this.monotonic(),
            signal: context.signal,
            onActivity: context.activity,
            beforeSend: () => {
              if (this.monotonic() > sendBy) throw new LinkTapError('late');
              this.stopSeq.set(timerId, this.nextSequence());
            },
          }),
        );
        this.stopTakenAt.set(timerId, this.monotonic());
        this.stopRetry.delete(timerId);
        if (guard && this.data.guards[timerId]?.stop === guard) {
          guard.acked = true;
          this.persist();
        }
        this.logger.info(`LinkTap ${timerId}: stop taken by the gateway`);
        this.updateStatus();
        return { sent: true, taken: true };
      } catch (err) {
        last = err;
        if (stopNotApplied(err) && this.monotonic() + TIMINGS.stopRetryDelay < sendBy) {
          await this.sleep(TIMINGS.stopRetryDelay);
          continue;
        }
        break;
      }
    }
    const reason = word(kindText(last.kind), this.language);
    this.logger.warn(`LinkTap ${timerId}: stop failed (${reasonOf(last)})`);
    if (last.kind === 'unknownTimer') {
      // The gateway does not know the timer: nothing to stop, nothing to send again.
      const guards = this.data.guards[timerId];
      if (guards?.stop) {
        delete guards.stop;
        this.cleanGuards(timerId);
        this.persist();
      }
      return { sent: true, error: this.refusal(ERRORS.unknownDevice) };
    }
    if (stopNotApplied(last) || last.kind === 'otherGateway') {
      // Surely not applied: never counted, tried again (spaced) until taken.
      return { sent: false, error: this.refusal(ERRORS.stopNotSent(reason)) };
    }
    if (refusedByGateway(last)) {
      return { sent: true, error: this.refusal(ERRORS.refused(reason)) };
    }
    // Left without an answer: it may have been applied.
    return { sent: true, error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
  }

  /**
   * Sends a stop again (reads, the 10 s ticker, restart), one at a time.
   *   - Not taken yet by the gateway: tried again without end, spaced (every
   *     10 s, every minute after 5 minutes of refusals); never counted.
   *   - Taken, but the same run still waters: 3 resends at most per stop,
   *     counted in /data when the gateway takes them or they leave without
   *     an answer (an answer proving nothing was applied never counts).
   */
  resendStop(timerId) {
    const guards = this.data.guards[timerId];
    const guard = guards?.stop;
    const gateway = guards && this.data.gateways[guards.gatewayId];
    if (!guard || !gateway?.address || this.resending.has(timerId)) {
      return;
    }
    const retry = this.stopRetry.get(timerId);
    if (!guard.acked && retry && this.monotonic() < retry.next) {
      return;
    }
    if (guard.acked && guard.resends >= TIMINGS.stopResends) {
      return;
    }
    const counts = guard.acked;
    this.resending.add(timerId);
    const mono = this.monotonic();
    this.sendStop(gateway, timerId, mono + TIMINGS.stopSendBy, mono + TIMINGS.ackBy)
      .then((outcome) => {
        if (counts && outcome.sent && this.data.guards[timerId]?.stop === guard) {
          // Counted once per resend, the 250 ms retry included.
          guard.resends += 1;
          this.persist();
        }
        if (!outcome.taken) {
          const previous = this.stopRetry.get(timerId);
          const since = previous?.since ?? mono;
          const slow = this.monotonic() - since >= TIMINGS.stopRetrySlowAfter;
          this.stopRetry.set(timerId, {
            failures: (previous?.failures ?? 0) + 1,
            since,
            next: this.monotonic() + (slow ? TIMINGS.stopRetrySlow : TIMINGS.stopRetryEvery) - 500,
          });
          this.logger.debug(`Stop sent again: ${outcome.error?.message}`);
        } else {
          this.logger.warn(
            `LinkTap ${timerId}: stop sent again${counts ? ` (${guard.resends}/${TIMINGS.stopResends})` : ''}`,
          );
        }
        this.updateStatus();
      })
      .finally(() => this.resending.delete(timerId));
  }

  // --- Pause of the watering plan --------------------------------------------

  async pauseCommand(gateway, timer, received) {
    const config = this.latest;
    if (!config?.address || gateway.address !== config.key || !gateway.timers.includes(timer)) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.paused(config.key)) throw this.refusal(ERRORS.blocked);
    if (this.pending.has(timer.id)) throw this.refusal(ERRORS.pending);
    const until = this.planPauseUntil.get(timer.id);
    if (until !== undefined && Math.min(until - this.monotonic(), TIMINGS.pauseGuard) > 0) {
      // A pause sent and not seen yet: a second one could switch the plan off.
      throw this.refusal(ERRORS.justPaused);
    }
    const ticket = { kind: 'pause', sent: false, acked: false, generation: this.generation };
    this.pending.set(timer.id, ticket);
    const hours = Math.min(PAUSE_HOURS.max, Math.max(PAUSE_HOURS.min, config.pauseHours));
    const check = () => {
      if (ticket.generation !== this.generation) throw this.refusal(ERRORS.configChanged);
      if (this.monotonic() > received + TIMINGS.commandQueueMax) throw this.refusal(ERRORS.tooSlow);
    };
    const work = (async () => {
      // Decided on a status read just now: a second pause can switch the plan off.
      const origin = { seq: 0 };
      let reading;
      try {
        reading = statusOf(
          await this.request(gateway.address, PRIORITY.COMMAND, (target, context) => {
            check();
            origin.seq = this.nextSequence();
            return this.client.status(target, gateway.id, timer.id, {
              timeout: TIMINGS.requestTimeout,
              signal: context.signal,
              onActivity: context.activity,
            });
          }),
          timer.id,
          gateway.volumeUnit,
        );
      } catch (err) {
        if (err.refusal) throw err;
        this.onFailure(gateway.address, err);
        throw this.refusal(ERRORS.unknownState);
      }
      if (!reading || reading.rfLinked === false || reading.paused === undefined) {
        throw this.refusal(ERRORS.unknownState);
      }
      this.handleReading(gateway, timer, reading, origin);
      if (reading.paused) {
        return { ok: true, nothing: true };
      }
      // The guard is on disk before the first byte, or nothing leaves.
      const guards = this.data.guards[timer.id] ?? { gatewayId: gateway.id };
      guards.gatewayId = gateway.id;
      guards.pause = { at: this.now(), until: this.now() + TIMINGS.pauseGuard };
      this.data.guards[timer.id] = guards;
      this.planPauseUntil.set(timer.id, this.monotonic() + TIMINGS.pauseGuard);
      if (!(await this.save())) {
        this.liftPause(timer.id);
        throw this.refusal(ERRORS.saveFailed);
      }
      try {
        await this.request(gateway.address, PRIORITY.SEND, (target, context) =>
          this.client.pausePlan(target, gateway.id, timer.id, hours, {
            timeout: TIMINGS.requestTimeout,
            sendWithin: received + TIMINGS.commandQueueMax - this.monotonic(),
            signal: context.signal,
            onActivity: context.activity,
            beforeSend: () => {
              check();
              ticket.sent = true;
              this.planPauseSeq.set(timer.id, this.nextSequence());
            },
          }),
        );
      } catch (err) {
        if (err.refusal || err.beforeSend || !err.sent || refusedByGateway(err)) {
          // Surely not applied: the guard goes.
          this.liftPause(timer.id);
        }
        throw err;
      }
      this.logger.info(`LinkTap ${timer.id}: watering plan paused for ${hours} h`);
      return { ok: true };
    })().then(
      (result) => result,
      (err) => ({ err }),
    );
    const settled = work.then((result) => {
      if (this.pending.get(timer.id) === ticket) this.pending.delete(timer.id);
      if (result.err && result.err.sent && !refusedByGateway(result.err)) {
        this.onFailure(gateway.address, result.err);
      }
      if (result.err && ticket.acked && !ticket.sent) {
        const err = result.err;
        this.noteLate(timer, 'pauseNotSent', err);
      }
      if (result.ok && !result.nothing) this.followUp(gateway);
      return result;
    });
    const result = await this.ackOf(settled, received, ticket);
    if (result.err) {
      const err = result.err;
      if (err.refusal) throw err;
      const reason = word(kindText(err.kind), this.language);
      if (err.beforeSend || !err.sent) throw this.refusal(ERRORS.notSent(reason));
      if (refusedByGateway(err)) throw this.refusal(ERRORS.refused(reason));
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (result.nothing) {
      return;
    }
    const confirmed = await this.confirm(
      gateway,
      timer,
      received,
      (reading) => reading.paused === true,
    );
    if (!confirmed) {
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.language)));
    }
  }

  // --- Follow-ups --------------------------------------------------------------

  /**
   * After a command: the gateway is read at 5, 15, 30 and 60 s (never during
   * a pause nor sooner than a backoff). A new command replaces the series.
   * The stops not taken yet are sent again by `retryStops` (every 10 s).
   */
  followUp(gateway) {
    const address = gateway.address;
    for (const handle of this.followUps.get(address) ?? []) {
      this.timers.clearTimeout(handle);
    }
    const handles = TIMINGS.followUps.map((delay) =>
      this.timers.setTimeout(() => {
        const status = this.status;
        if (
          this.stopped ||
          !this.config ||
          address !== this.config.key ||
          this.paused() ||
          (status?.failures > 0 && this.monotonic() < status.next)
        ) {
          return;
        }
        this.read()
          .then((changed) => (changed ? this.publishDevices() : undefined))
          .then(() => this.updateStatus())
          .catch(() => this.logger.warn('Read after a command failed'));
      }, delay),
    );
    this.followUps.set(address, handles);
  }
}
