// -----------------------------------------------------------------------------
// Fixed values: manifest keys (frozen: users store them in their scenes and
// configuration), the Gladys core value enums the SDK does not export, the
// facts of the LinkTap local HTTP API, limits and timings.
// -----------------------------------------------------------------------------

/** External id type: `gladys.externalIds(type, <timer id>)`. Frozen. */
export const EXTERNAL_ID_TYPE = 'linktap';

/** Manifest `actions` keys. */
export const ACTIONS = {
  CHECK: 'check_gateway',
};

// Gladys core enum (server/utils/constants.js), not exported by the SDK.
export const BUTTON_PUSH = { PRESSED: 1 };

/**
 * The commands of the LinkTap local HTTP API (POST /api.shtml, a JSON body
 * with `cmd`, `gw_id` and `dev_id`), as the LinkTap protocol numbers them.
 */
export const CMD = {
  STATUS: 3,
  START: 6,
  STOP: 7,
  CONFIG: 16,
  PAUSE_PLAN: 18,
};

/**
 * `ret` of a gateway answer (LinkTap protocol): 0 success, 1 message format
 * error, 2 command not supported, 3 gateway id not matched, 4 end device id
 * error, 5 end device id not found, 6 gateway internal error, 7 conflict with
 * the watering plan, 8 gateway busy, 9 bad parameter.
 */
export const RET = {
  OK: 0,
  FORMAT: 1,
  UNSUPPORTED: 2,
  GATEWAY_MISMATCH: 3,
  DEVICE_ID: 4,
  DEVICE_NOT_FOUND: 5,
  INTERNAL: 6,
  PLAN_CONFLICT: 7,
  BUSY: 8,
  BAD_PARAMETER: 9,
};

/** The API path and port of the gateway (plain HTTP: the GW-02 has no https API). */
export const API_PATH = '/api.shtml';
export const DEFAULT_PORT = 80;

/** A US gallon in litres (the gateway counts in L or gal, `vol_unit` of cmd 16). */
export const LITRES_PER_GALLON = 3.785411784;

/** Watering length of a timer started from Gladys, in minutes (the module's own cap). */
export const WATERING_MINUTES = { default: 15, min: 1, max: 120 };

/** Length of a pause of the watering plan, in hours (the protocol accepts 0.1 to 240). */
export const PAUSE_HOURS = { default: 24, min: 1, max: 240 };

/** Configuration bounds of the refresh interval, in seconds (mirrored by the manifest). */
export const POLL_INTERVAL = { default: 30, min: 15, max: 600 };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Water timers read from one gateway (a GW-02 takes 15; sub-devices `_n` included). */
  timers: 32,
  /** Gateways remembered in /data (one typed address; a replaced one keeps its devices). */
  gateways: 4,
  /** Body of a gateway answer (well under 4 kB in practice). */
  responseBytes: 64 * 1024,
  /** Plausible bounds of the values read (never published outside). */
  flowLitresPerMinute: 1000,
  sessionLitres: 20_000,
  remainingSeconds: 86_400,
};

export const TIMINGS = {
  /** One HTTP request of the polling (one at a time: the gateway takes one). */
  requestTimeout: 3000,
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
  /** Saving /data waits this long for more changes. */
  persistDelay: 1000,
  /** The time of the last read is written to /data at most this often. */
  lastTrySave: 60_000,
  /** The ack of a command is given by then (Gladys gives up after 5 s). */
  ackBy: 3400,
  /** A command must have left by then, else it is dropped unsent. */
  commandSendBy: 3300,
  /**
   * A start or a pause still waiting for the gateway at the ack (another
   * request ahead of it: one at a time) may leave until then, unless a stop of
   * its timer cancels it; the ack says it is queued.
   */
  commandQueueMax: 10_000,
  /** A stop waits for the request in flight at most this long, or this long without a byte. */
  protectiveWait: 1500,
  stallCut: 1000,
  /** A stop that could not leave is tried again after this, within its deadline. */
  stopRetryDelay: 250,
  /** A stop leaves within this many ms of its arrival, or is "not sent" (the reads send it). */
  stopSendBy: 3000,
  /** A stop the gateway took is sent again by a read still showing watering only after this. */
  radioDelay: 4000,
  /** Before a confirmation read, the timer gets this long to apply a command (radio). */
  confirmDelay: 1200,
  /** Reads after a command; a stop not taken yet is also sent again at these times. */
  followUps: [5000, 15_000, 30_000, 60_000],
  /** After a start that may have left, no other start of the timer for this long. */
  startGuard: 60_000,
  /** A stop is sent again at most this many times (counted only when it left). */
  stopResends: 3,
  /** A stop not taken by the gateway yet is tried again this often (even during a pause). */
  stopRetryEvery: 10_000,
  /** After a pause of the plan sent, no other one until a read shows it, or this long. */
  pauseGuard: 10 * 60_000,
  /** A new run: its time left grew by more than this (s) since the run seen at the stop. */
  runTolerance: 2,
  /** A run is younger than the stop when its elapsed time is shorter than the time since the click, less this (s). */
  runAgeMargin: 1.5,
  /** A stop not taken: tried again every 10 s for this long, then every minute, without end. */
  stopRetrySlowAfter: 5 * 60_000,
  stopRetrySlow: 60_000,
  /** The outcome of a queued command that did not leave stays in the status this long. */
  noteLife: 30 * 60_000,
  /** Transient failures: the next reads, never sooner than the interval. */
  backoff: [30_000, 60_000, 120_000, 300_000],
  /** HTTP 429, 5xx or a busy gateway: a pause within these bounds. */
  pauseMin: 60_000,
  pauseMax: 6 * 60 * 60_000,
  /** `getConfig()` failed: tried again after these, then every minute, without end. */
  configRetry: [5000, 15_000, 30_000, 60_000],
};
