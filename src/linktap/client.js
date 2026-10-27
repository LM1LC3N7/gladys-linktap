// -----------------------------------------------------------------------------
// The LinkTap local HTTP API: POST /api.shtml with a JSON body. Every request
// of a command carries the gateway id and the water timer id: the gateway
// itself refuses a command meant for another gateway (`ret` 3) or a timer it
// does not know (`ret` 5), so a command never reaches another device at the
// address. An answer is taken only when it is the answer to this request (its
// `cmd`, `gw_id` and `dev_id`, when present, are the ones sent).
// -----------------------------------------------------------------------------

import { API_PATH, CMD, LIMITS, RET } from '../constants.js';
import { LinkTapError } from './errors.js';
import { httpRequest } from './http.js';
import { gatewayIdOf, idOf, parseAnswer } from './parse.js';

/**
 * `Retry-After` in ms, in seconds only (an HTTP date would be compared with a
 * clock the gateway may not share: the default pause applies), or undefined.
 */
function retryAfterOf(value) {
  if (typeof value !== 'string' || !/^\s*\d{1,6}\s*$/.test(value)) {
    return undefined;
  }
  return Number(value.trim()) * 1000;
}

/** The error of a non-zero `ret`. */
function retError(ret) {
  const kind =
    ret === RET.GATEWAY_MISMATCH
      ? 'otherGateway'
      : ret === RET.DEVICE_ID || ret === RET.DEVICE_NOT_FOUND
        ? 'unknownTimer'
        : ret === RET.INTERNAL || ret === RET.BUSY
          ? 'busy'
          : ret === RET.PLAN_CONFLICT
            ? 'conflict'
            : 'protocol';
  return new LinkTapError(kind, { sent: true, ret });
}

export class LinkTapClient {
  constructor({ request = httpRequest } = {}) {
    this.request = request;
  }

  /**
   * One request. `target`: { host, port }. Options: timeout, sendWithin,
   * beforeSend, signal, onActivity. Resolves the answer object (`ret` 0 or
   * absent); rejects a LinkTapError.
   */
  async call(target, payload, options = {}) {
    const response = await this.request({
      host: target.host,
      port: target.port,
      path: API_PATH,
      body: Buffer.from(JSON.stringify(payload)),
      timeout: options.timeout,
      sendWithin: options.sendWithin,
      maxBytes: LIMITS.responseBytes,
      beforeSend: options.beforeSend,
      signal: options.signal,
      onActivity: options.onActivity,
    });
    const status = response.status;
    if (status === 429 || status >= 500) {
      throw new LinkTapError('busy', {
        status,
        sent: true,
        retryAfter: retryAfterOf(response.headers?.['retry-after']),
      });
    }
    if (status !== 200) {
      throw new LinkTapError('http', { status, sent: true });
    }
    const json = parseAnswer(response.body, response.headers?.['content-type']);
    const ret = json.ret;
    if (ret !== undefined && ret !== RET.OK) {
      if (!Number.isInteger(ret)) {
        throw new LinkTapError('invalid', { sent: true });
      }
      throw retError(ret);
    }
    // Only the answer to this request.
    if (json.cmd !== undefined && json.cmd !== payload.cmd) {
      throw new LinkTapError('invalid', { sent: true });
    }
    if (payload.gw_id && json.gw_id !== undefined && gatewayIdOf(json) !== payload.gw_id) {
      throw new LinkTapError('otherGateway', { sent: true });
    }
    if (payload.dev_id && json.dev_id !== undefined && idOf(json.dev_id) !== payload.dev_id) {
      throw new LinkTapError('invalid', { sent: true });
    }
    return json;
  }

  /**
   * The id of the gateway answering at an address: a status request without
   * ids, which the gateway answers with its own id (and an error `ret`).
   */
  async probe(target, options) {
    const response = await this.request({
      host: target.host,
      port: target.port,
      path: API_PATH,
      body: Buffer.from(JSON.stringify({ cmd: CMD.STATUS })),
      timeout: options.timeout,
      maxBytes: LIMITS.responseBytes,
      signal: options.signal,
      onActivity: options.onActivity,
    });
    if (response.status === 429 || response.status >= 500) {
      throw new LinkTapError('busy', {
        status: response.status,
        sent: true,
        retryAfter: retryAfterOf(response.headers?.['retry-after']),
      });
    }
    if (response.status !== 200) {
      throw new LinkTapError('http', { status: response.status, sent: true });
    }
    const json = parseAnswer(response.body, response.headers?.['content-type']);
    const id = gatewayIdOf(json);
    if (!id) {
      throw new LinkTapError('invalid', { sent: true });
    }
    return id;
  }

  config(target, gatewayId, options) {
    return this.call(target, { cmd: CMD.CONFIG, gw_id: gatewayId }, options);
  }

  status(target, gatewayId, timerId, options) {
    return this.call(target, { cmd: CMD.STATUS, gw_id: gatewayId, dev_id: timerId }, options);
  }

  /** Instant watering for `seconds` (bounded by the caller), never by volume. */
  start(target, gatewayId, timerId, seconds, options) {
    return this.call(
      target,
      { cmd: CMD.START, gw_id: gatewayId, dev_id: timerId, duration: seconds },
      options,
    );
  }

  stop(target, gatewayId, timerId, options) {
    return this.call(target, { cmd: CMD.STOP, gw_id: gatewayId, dev_id: timerId }, options);
  }

  pausePlan(target, gatewayId, timerId, hours, options) {
    return this.call(
      target,
      { cmd: CMD.PAUSE_PLAN, gw_id: gatewayId, dev_id: timerId, duration: hours },
      options,
    );
  }
}
