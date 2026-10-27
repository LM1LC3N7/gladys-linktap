// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// The publisher keeps the LAST value of each feature, sends the pending ones
// every second within a per-minute budget, skips the unchanged ones
// (publishChangedStates). The budget runs on the monotonic clock. Taken from
// LM1LC3N7/gladys-yardian (same author, Apache-2.0), through gladys-ikea.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({ gladys, logger, monotonic, timers, budget = LIMITS.statesPerMinute }) {
    this.gladys = gladys;
    this.logger = logger;
    this.monotonic = monotonic;
    this.timers = timers;
    this.budget = budget;
    /** featureId -> { state } */
    this.pending = new Map();
    /** send times of the last minute (monotonic) */
    this.window = [];
    this.timer = undefined;
    this.flushing = undefined;
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forgets a device (deleted): its pending values are dropped. */
  forget(deviceId) {
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.pending.delete(key);
      }
    }
  }

  /** A reconnection to Gladys: nothing pending of before is sent, every value is sent again. */
  reset() {
    this.pending.clear();
    this.gladys.forgetPublishedStates();
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.monotonic();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    if (room <= 0 || this.pending.size === 0) {
      return 0;
    }
    const batch = [];
    for (const [featureId, value] of this.pending) {
      if (room <= 0) {
        break;
      }
      this.pending.delete(featureId);
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    if (batch.length === 0) {
      return 0;
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      const count = result?.count ?? batch.length;
      for (let i = 0; i < count; i += 1) {
        this.window.push(now);
      }
      return count;
    } catch (err) {
      // Keep the values for the next round, unless a newer one arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
