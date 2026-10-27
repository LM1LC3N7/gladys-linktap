// -----------------------------------------------------------------------------
// One request at a time to a gateway (the LinkTap gateway handles one local
// API request at a time; LinkTap's own guidance and the openHAB binding keep a
// single exchange in flight). Every request of the integration goes through
// the lane of its gateway, in the order of their priority:
//   0 PROTECTIVE  stops: ahead of everything queued;
//   1 COMMAND     starts, pauses of the plan and their reads;
//   2 READ        polling, confirmation and follow-up reads.
// A stop never overlaps a request either: it waits for the one in flight, but
// cuts it (closed, then the stop leaves) when it has been silent for
// `stallCut` ms, or when the stop has waited `protectiveWait` ms. A request
// cut this way is not a failure of the gateway. A queued request whose signal
// is aborted (a start cancelled by a stop) leaves the queue unsent.
// -----------------------------------------------------------------------------

import { LinkTapError } from './errors.js';

export const PRIORITY = { PROTECTIVE: 0, COMMAND: 1, READ: 2 };

export class GatewayLane {
  constructor({ monotonic, timers, stallCut, protectiveWait }) {
    this.monotonic = monotonic;
    this.timers = timers;
    this.stallCut = stallCut;
    this.protectiveWait = protectiveWait;
    this.queue = [];
    this.current = undefined;
    this.watchdog = undefined;
    /** Requests that have run, for the tests: never two at once. */
    this.running = 0;
    this.peak = 0;
  }

  /**
   * Runs `task(context)` when its turn comes. `context.signal` aborts it
   * (cancelled, or cut by a stop), `context.activity()` marks a byte received.
   * @returns {Promise<any>}
   */
  run(task, { priority = PRIORITY.READ, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new LinkTapError('cancelled'));
        return;
      }
      const entry = { task, priority, signal, resolve, reject, queuedAt: this.monotonic() };
      if (signal) {
        entry.onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) {
            this.queue.splice(index, 1);
            reject(new LinkTapError('cancelled'));
          }
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      // Stable by priority: a stop goes ahead of every non-protective request.
      const at = this.queue.findIndex((e) => e.priority > priority);
      if (at < 0) {
        this.queue.push(entry);
      } else {
        this.queue.splice(at, 0, entry);
      }
      this.pump();
      this.watch();
    });
  }

  /** A protective request is waiting behind a non-protective one in flight. */
  protectiveWaiting() {
    return (
      this.current !== undefined &&
      this.current.priority !== PRIORITY.PROTECTIVE &&
      this.queue.some((e) => e.priority === PRIORITY.PROTECTIVE)
    );
  }

  watch() {
    if (this.watchdog || !this.protectiveWaiting()) {
      return;
    }
    this.watchdog = this.timers.setInterval(() => this.check(), 50);
    this.check();
  }

  check() {
    if (!this.protectiveWaiting()) {
      this.timers.clearInterval(this.watchdog);
      this.watchdog = undefined;
      return;
    }
    const mono = this.monotonic();
    const waited =
      mono - Math.min(...this.queue.filter((e) => e.priority === 0).map((e) => e.queuedAt));
    const silent = mono - this.current.lastActivity;
    if (silent >= this.stallCut || waited >= this.protectiveWait) {
      this.current.controller.abort('cut');
    }
  }

  pump() {
    if (this.current || this.queue.length === 0) {
      return;
    }
    const entry = this.queue.shift();
    entry.signal?.removeEventListener('abort', entry.onAbort);
    const controller = new AbortController();
    if (entry.signal) {
      // A cancellation reaches the request in flight (dropped if not connected yet).
      entry.onAbort = () => controller.abort('cancelled');
      entry.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    entry.controller = controller;
    entry.lastActivity = this.monotonic();
    this.current = entry;
    this.running += 1;
    this.peak = Math.max(this.peak, this.running);
    const context = {
      signal: controller.signal,
      activity: () => {
        entry.lastActivity = this.monotonic();
      },
    };
    let result;
    try {
      result = Promise.resolve(entry.task(context));
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(entry.resolve, entry.reject).finally(() => {
      entry.signal?.removeEventListener('abort', entry.onAbort);
      this.running -= 1;
      this.current = undefined;
      this.pump();
      this.watch();
    });
  }

  /** Drops what waits (shutdown): rejected as cancelled, nothing sent. */
  clear() {
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.reject(new LinkTapError('cancelled'));
    }
    this.timers.clearInterval(this.watchdog);
    this.watchdog = undefined;
  }
}
