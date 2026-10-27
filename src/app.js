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
//     watering", checked on arrival, when its turn comes and right before the
//     request leaves). The length is the configured one, 120 minutes at most,
//     carried by the command: the water timer closes by itself at the end. A
//     guard is on disk before the first byte (refused otherwise) and refuses
//     another start of the timer for a minute; a pause or an unreadable /data
//     refuses it. Queued behind another request at the ack (3.4 s), it may
//     leave within 10 s of the click unless a stop of the timer cancels it.
//   - Stop: never held by the option, a pause, the guards, a missing
//     configuration or a request in flight (it goes ahead of the queue and
//     cuts a request silent for 1 s, or after 1.5 s). It cancels the starts of
//     its timer not sent yet. Not sent (no connection, a busy gateway): tried
//     again 250 ms later within its 3 s, then sent again by the follow-ups
//     (5, 15, 30, 60 s, even during a pause) and after a restart, 3 times at
//     most. Taken by the gateway but a read still shows the timer watering:
//     sent again (the same 3 times at most). The stop guard is lifted by a
//     read showing the timer dry, then watering started elsewhere and read
//     twice in a row, or by a start from Gladys that really leaves: never by
//     the time alone. Refused unsent only when no address of the gateway is
//     known, or the gateway does not know the timer.
//   - Pause of the watering plan (the configured hours): decided on a status
//     read just now; already paused: nothing sent (a second pause can switch
//     the plan off, LinkTap issue).
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
      if (guards.stop && !guards.stop.acked) {
        this.logger.info(`LinkTap ${timerId}: a stop not taken before the restart, sent again`);
        this.resendStop(timerId);
        const gateway = this.data.gateways[guards.gatewayId];
        if (gateway?.address) {
          // Not taken this time either: the follow-ups send it again.
          this.followUp(gateway);
        }
      }
    }
  }

  /** A configuration saved (or read at a connection): applied one at a time, the last one wins. */
  start(raw = {}) {
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
    if (this.config.key !== this.configKey) {
      this.configKey = this.config.key;
      this.generation += 1;
      if (this.status?.address !== this.config.key) {
        this.status = undefined;
        this.moved = undefined;
      }
      this.reading = undefined;
    }
    this.refreshCreated();
    this.publisher.start();
    await this.publishDevices();
    await this.publishAllTransports();
    this.schedule();
    this.updateStatus();
    const changed = await this.poll();
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
        } else if (
          TRANSPORT_KINDS.has(err.kind) ||
          err.kind === 'busy' ||
          gateway.timers.length === 0
        ) {
          throw err;
        } else {
          // The timers are known: the configuration is secondary.
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
        if (err.kind === 'unreachable' || err.kind === 'busy' || err.kind === 'otherGateway') {
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
      this.watchGuards(gateway, timer.id, reading.watering, origin);
    }
  }

  /**
   * The guards of a timer against a reading sent after their command:
   *   - start guard: lifted by the timer seen watering;
   *   - stop guard, before a dry reading: watering -> the stop is sent again
   *     (3 times at most); dry -> "dry", kept;
   *   - stop guard, dry: a watering read twice in a row was started elsewhere
   *     (the app, the button, the plan): the guard is lifted.
   */
  watchGuards(gateway, timerId, watering, origin) {
    const guards = this.data.guards[timerId];
    if (!guards) {
      return;
    }
    const startSeq = guards.startSeq;
    if (guards.start && watering && (startSeq === undefined || origin.seq > startSeq)) {
      this.liftStart(timerId);
    }
    const stop = guards.stop;
    const stopSeq = this.stopSeq.get(timerId);
    if (!stop || (stopSeq !== undefined && origin.seq <= stopSeq)) {
      return;
    }
    if (!stop.dry) {
      if (!watering) {
        stop.dry = true;
        stop.seenWatering = 0;
        this.persist();
        this.updateStatus();
      } else if (
        !stop.acked ||
        this.monotonic() - (this.stopTakenAt.get(timerId) ?? -Infinity) >= TIMINGS.radioDelay
      ) {
        // Taken by the gateway a moment ago: the radio may not have carried it yet.
        this.resendStop(timerId);
      }
      return;
    }
    if (watering) {
      stop.seenWatering += 1;
      if (stop.seenWatering >= 2) {
        this.logger.info(`LinkTap ${timerId}: watering started elsewhere, stop guard lifted`);
        delete guards.stop;
        this.cleanGuards(timerId);
      }
      this.persist();
    } else if (stop.seenWatering > 0) {
      stop.seenWatering = 0;
      this.persist();
    }
  }

  cleanGuards(timerId) {
    const guards = this.data.guards[timerId];
    if (guards && !guards.start && !guards.stop) {
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
  stopsNotTaken() {
    const names = [];
    for (const [timerId, guards] of Object.entries(this.data?.guards ?? {})) {
      if (guards.stop && !guards.stop.dry && guards.stop.resends >= TIMINGS.stopResends) {
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
        connected = Boolean(gateway);
        if (gateway) {
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
    const error = new Error(word(text, this.config?.language ?? 'fr'));
    error.refusal = true;
    return error;
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
    if (target.key === 'stop') {
      return this.stopCommand(target.gateway, target.timer, received);
    }
    if (target.key === 'start') {
      return this.startCommand(target.gateway, target.timer, received);
    }
    return this.pauseCommand(target.gateway, target.timer, received);
  }

  /** The checks every start makes on arrival, at its turn and right before it leaves. */
  checkStart(gateway, timer, ticket, received) {
    if (ticket?.cancelled) throw this.refusal(ERRORS.cancelled);
    if (ticket && ticket.generation !== this.generation) throw this.refusal(ERRORS.configChanged);
    if (!this.config?.allowWatering) throw this.refusal(ERRORS.wateringDisabled);
    if (this.dataBroken) throw this.refusal(ERRORS.dataBroken);
    if (
      !gateway.address ||
      gateway.address !== this.config.key ||
      this.data.gateways[gateway.id] !== gateway ||
      !gateway.timers.includes(timer)
    ) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.paused()) throw this.refusal(ERRORS.blocked);
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
      throw this.refusal(
        ticket.sent
          ? ERRORS.sentUnconfirmed(word(ERRORS.noAnswer, this.config?.language))
          : ERRORS.queued,
      );
    }
    return result;
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
      generation: this.generation,
      abort: new AbortController(),
    };
    this.pending.set(timer.id, ticket);
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
    const minutes = Math.min(
      WATERING_MINUTES.max,
      Math.max(WATERING_MINUTES.min, this.config.wateringMinutes),
    );
    const seconds = minutes * 60;
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
      await this.request(
        gateway.address,
        PRIORITY.COMMAND,
        (target, context) => {
          this.checkStart(gateway, timer, ticket, received);
          this.logger.info(`LinkTap ${timer.id}: start for ${minutes} min`);
          return this.client.start(target, gateway.id, timer.id, seconds, {
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
      } else if (refusedByGateway(err)) {
        this.onFailure(gateway.address, err);
        this.liftStart(timer.id);
        this.logger.warn(`LinkTap ${timer.id}: start refused (${reasonOf(err)})`);
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
            : ERRORS.notSent(word(kindText(err.kind), this.config.language)),
        );
      }
      if (refusedByGateway(err)) {
        throw this.refusal(ERRORS.refused(word(kindText(err.kind), this.config.language)));
      }
      throw this.refusal(ERRORS.sentUnconfirmed(word(kindText(err.kind), this.config.language)));
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
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.config.language)));
    }
  }

  /**
   * A read of the timer after a command (the radio gets `confirmDelay` to
   * carry it), within the ack: true when `wanted(reading)`. It feeds the
   * guards and the values like any read.
   */
  async confirm(gateway, timer, received, wanted) {
    const ackAt = received + TIMINGS.ackBy;
    const readAt = this.monotonic() + TIMINGS.confirmDelay;
    if (ackAt - readAt < 400 || this.paused(gateway.address)) {
      return false;
    }
    await this.sleep(TIMINGS.confirmDelay);
    const origin = { seq: 0 };
    try {
      const json = await Promise.race([
        this.request(gateway.address, PRIORITY.COMMAND, (target, context) => {
          origin.seq = this.nextSequence();
          return this.client.status(target, gateway.id, timer.id, {
            timeout: Math.max(100, ackAt - this.monotonic() - 100),
            signal: context.signal,
            onActivity: context.activity,
          });
        }),
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
    const guards = this.data.guards[timer.id] ?? { gatewayId: gateway.id };
    guards.gatewayId = gateway.id;
    guards.stop = { at: this.now(), acked: false, dry: false, resends: 0, seenWatering: 0 };
    this.data.guards[timer.id] = guards;
    // On disk if it can be within 300 ms: a stop never waits for /data.
    await Promise.race([this.save(), this.sleep(300)]);
    const outcome = await this.sendStop(
      gateway,
      timer.id,
      received + TIMINGS.stopSendBy,
      received + TIMINGS.ackBy - 100,
    );
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
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.config?.language)));
    }
  }

  /**
   * Sends the stop of a timer, ahead of the queue; tried again once 250 ms
   * later when it could not leave or the gateway was busy, within `sendBy`.
   * Resolves `{ sent, error }`, never rejects.
   */
  async sendStop(gateway, timerId, sendBy, answerBy) {
    const language = this.config?.language ?? 'fr';
    const address = gateway.address;
    let last;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const guard = this.data.guards[timerId]?.stop;
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
        if (guard && this.data.guards[timerId]?.stop === guard) {
          guard.acked = true;
          this.persist();
        }
        this.logger.info(`LinkTap ${timerId}: stop taken by the gateway`);
        return { sent: true };
      } catch (err) {
        last = err;
        const notApplied = !err.sent || err.kind === 'busy' || err.kind === 'http';
        if (
          notApplied &&
          err.kind !== 'otherGateway' &&
          this.monotonic() + TIMINGS.stopRetryDelay < sendBy
        ) {
          await this.sleep(TIMINGS.stopRetryDelay);
          continue;
        }
        break;
      }
    }
    const reason = word(kindText(last.kind), language);
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
    if (
      !last.sent ||
      last.kind === 'busy' ||
      last.kind === 'otherGateway' ||
      last.kind === 'late'
    ) {
      return { sent: false, error: this.refusal(ERRORS.stopNotSent(reason)) };
    }
    if (refusedByGateway(last)) {
      return { sent: true, error: this.refusal(ERRORS.refused(reason)) };
    }
    return { sent: true, error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
  }

  /** Sends a stop again (reads, follow-ups, restart): 3 times at most per stop, counted in /data. */
  resendStop(timerId) {
    const guards = this.data.guards[timerId];
    const guard = guards?.stop;
    const gateway = guards && this.data.gateways[guards.gatewayId];
    if (
      !guard ||
      !gateway?.address ||
      this.resending.has(timerId) ||
      guard.resends >= TIMINGS.stopResends
    ) {
      return;
    }
    guard.resends += 1;
    this.save();
    this.resending.add(timerId);
    this.logger.warn(
      `LinkTap ${timerId}: stop sent again (${guard.resends}/${TIMINGS.stopResends})`,
    );
    const mono = this.monotonic();
    this.sendStop(gateway, timerId, mono + TIMINGS.stopSendBy, mono + TIMINGS.ackBy)
      .then((outcome) => {
        if (outcome.error) this.logger.warn(`Stop sent again: ${outcome.error.message}`);
        this.updateStatus();
      })
      .finally(() => this.resending.delete(timerId));
  }

  // --- Pause of the watering plan --------------------------------------------

  async pauseCommand(gateway, timer, received) {
    if (
      !this.config?.address ||
      gateway.address !== this.config.key ||
      !gateway.timers.includes(timer)
    ) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.paused()) throw this.refusal(ERRORS.blocked);
    if (this.pending.has(timer.id)) throw this.refusal(ERRORS.pending);
    const ticket = { kind: 'pause', sent: false, generation: this.generation };
    this.pending.set(timer.id, ticket);
    const hours = Math.min(PAUSE_HOURS.max, Math.max(PAUSE_HOURS.min, this.config.pauseHours));
    const work = (async () => {
      // Decided on a status read just now: a second pause can switch the plan off.
      const origin = { seq: 0 };
      let reading;
      try {
        reading = statusOf(
          await this.request(gateway.address, PRIORITY.COMMAND, (target, context) => {
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
      await this.request(gateway.address, PRIORITY.COMMAND, (target, context) =>
        this.client.pausePlan(target, gateway.id, timer.id, hours, {
          timeout: TIMINGS.requestTimeout,
          sendWithin: received + TIMINGS.commandQueueMax - this.monotonic(),
          signal: context.signal,
          onActivity: context.activity,
          beforeSend: () => {
            if (ticket.generation !== this.generation) throw this.refusal(ERRORS.configChanged);
            if (this.monotonic() > received + TIMINGS.commandQueueMax)
              throw this.refusal(ERRORS.tooSlow);
            ticket.sent = true;
          },
        }),
      );
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
      if (result.ok && !result.nothing) this.followUp(gateway);
      return result;
    });
    const result = await this.ackOf(settled, received, ticket);
    if (result.err) {
      const err = result.err;
      if (err.refusal) throw err;
      const reason = word(kindText(err.kind), this.config.language);
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
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.config.language)));
    }
  }

  // --- Follow-ups --------------------------------------------------------------

  /**
   * After a command: at 5, 15, 30 and 60 s, the stops of the gateway not
   * taken yet are sent again (even during a pause), and the gateway is read
   * (never during a pause nor sooner than a backoff). A new command replaces
   * the series.
   */
  followUp(gateway) {
    const address = gateway.address;
    for (const handle of this.followUps.get(address) ?? []) {
      this.timers.clearTimeout(handle);
    }
    const handles = TIMINGS.followUps.map((delay) =>
      this.timers.setTimeout(() => {
        if (this.stopped) {
          return;
        }
        for (const [timerId, guards] of Object.entries(this.data.guards)) {
          if (guards.gatewayId === gateway.id && guards.stop && !guards.stop.acked) {
            this.resendStop(timerId);
          }
        }
        const status = this.status;
        if (
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
