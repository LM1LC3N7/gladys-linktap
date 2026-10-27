// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP request to a
// LinkTap gateway on node:http (its local API speaks no TLS). A deadline for
// the whole exchange, a size cap on the body (checked chunk by chunk, before
// the answer is complete), no redirect followed, no keep-alive, one connection
// per request. Resolves { status, headers, body } for any status; rejects a
// LinkTapError for the transport failures, with `sent` true as soon as the
// connection was up (the request may then have reached the gateway).
//
// A failed request settles only once its socket is closed and 50 ms more (at
// most 300 ms after): the next request of the lane never overlaps it (the
// gateway takes one request at a time).
//
// `sendWithin`: the connection must be up within this many ms, else nothing is
// written (a command never leaves late). `beforeSend`: the last check of a
// command, once connected, right before the first byte is written. `signal`:
// aborted before the connection is up, the request is dropped unsent
// ('cancelled'); aborted after with the reason 'cut' (a stop waiting behind
// it), it is cut ('cut', may have left). `onActivity`: called at every byte
// received (the lane cuts a request silent for a second when a stop waits).
// Adapted from LM1LC3N7/gladys-yardian (same author, Apache-2.0).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { LinkTapError } from './errors.js';

const CLOSE_WAIT = 300;
const CLOSE_GRACE = 50;

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP (a wrong port).
  if (code.startsWith('HPE_')) {
    return new LinkTapError('invalid', { sent });
  }
  // Only our own words: a system message may carry an address.
  return new LinkTapError('unreachable', { sent });
}

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path
 * @param {Buffer} options.body the JSON body (POST)
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.beforeSend] if it throws, nothing is sent and
 *   its error is passed on with `beforeSend` set
 * @param {AbortSignal} [options.signal]
 * @param {() => void} [options.onActivity]
 */
export function httpRequest({
  host,
  port,
  path,
  body,
  timeout,
  sendWithin,
  maxBytes,
  beforeSend,
  signal,
  onActivity,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let socket = null;
    let socketClosed = false;
    // Until the connection is up, nothing of the request has left.
    let connected = false;

    const done = (error, value) => {
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      signal?.removeEventListener('abort', onAbort);
      if (!error) {
        done(null, value);
        return;
      }
      req?.destroy();
      if (!socket || socketClosed) {
        done(error);
        return;
      }
      // Settled once the socket is closed, and the gateway had a moment to
      // see it: never two connections at once.
      const cap = setTimeout(() => done(error), CLOSE_WAIT);
      socket.once('close', () => {
        clearTimeout(cap);
        setTimeout(() => done(error), CLOSE_GRACE);
      });
    };
    const timer = setTimeout(
      () => finish(new LinkTapError('timeout', { sent: connected })),
      Math.max(0, timeout),
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new LinkTapError('late'));
              }
            },
            Math.max(0, sendWithin),
          );
    const onAbort = () => {
      if (!connected) {
        finish(new LinkTapError('cancelled'));
      } else if (signal.reason === 'cut') {
        finish(new LinkTapError('cut', { sent: true }));
      }
    };
    if (signal?.aborted) {
      finish(new LinkTapError('cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    const markConnected = () => {
      if (connected || settled) {
        return;
      }
      clearTimeout(sendTimer);
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      connected = true;
      onActivity?.();
      req.end(body);
    };

    try {
      req = http.request({
        method: 'POST',
        host,
        port,
        path,
        agent: false,
        headers: {
          accept: 'application/json, text/html',
          host: port === 80 ? host : `${host}:${port}`,
          connection: 'close',
          'content-type': 'application/json; charset=UTF-8',
          'content-length': body.length,
        },
      });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        onActivity?.();
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish(new LinkTapError('tooLarge', { sent: true }));
          return;
        }
        res.on('data', (chunk) => {
          onActivity?.();
          size += chunk.length;
          if (size > maxBytes) {
            finish(new LinkTapError('tooLarge', { sent: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err, true)));
      });
      req.on('socket', (s) => {
        socket = s;
        s.once('close', () => {
          socketClosed = true;
        });
        if (!s.connecting) {
          markConnected();
        } else {
          s.once('connect', markConnected);
        }
      });
      req.on('error', (err) => finish(transportError(err, connected)));
    } catch (err) {
      // http.request throws on a path or a header it refuses: a failure, never a crash.
      finish(transportError(err, false));
    }
  });
}
