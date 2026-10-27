// -----------------------------------------------------------------------------
// The failures of a request to a gateway, by kind. Messages are our own words
// only: never an address, a header or a body.
// -----------------------------------------------------------------------------

/**
 * - timeout:      no complete answer in time
 * - unreachable:  no connection, or a connection lost
 * - late:         a command could not leave before its deadline (nothing sent)
 * - cancelled:    cancelled before its connection was up (nothing sent)
 * - cut:          cut by a stop waiting behind it (it may have left)
 * - busy:         HTTP 429 or 5xx, or `ret` 6 / 8: the gateway asks for a pause
 * - http:         another HTTP status (404 included: the gateway sometimes answers it)
 * - otherGateway: `ret` 3, another gateway answers at the address
 * - unknownTimer: `ret` 4 or 5, the gateway does not know the water timer
 * - conflict:     `ret` 7, the command conflicts with the watering plan
 * - protocol:     `ret` 1, 2 or 9, or another `ret`
 * - invalid:      not the JSON a LinkTap gateway answers, or not the answer
 *                 to this request
 * - tooLarge:     the answer exceeds the size cap
 */
export class LinkTapError extends Error {
  constructor(kind, { status, sent = false, retryAfter, ret } = {}) {
    super(status ? `${kind} (HTTP ${status})` : ret !== undefined ? `${kind} (ret ${ret})` : kind);
    this.name = 'LinkTapError';
    this.kind = kind;
    this.status = status;
    this.sent = sent;
    this.retryAfter = retryAfter;
    this.ret = ret;
  }
}

/** A short reason for the logs and the user: the kind, and the status if any. */
export const reasonOf = (err) => (err instanceof LinkTapError ? err.message : 'unexpected error');

/** The gateway answered and surely did nothing with the command. */
export const refusedByGateway = (err) =>
  err instanceof LinkTapError &&
  err.sent &&
  (['otherGateway', 'unknownTimer', 'conflict', 'protocol'].includes(err.kind) ||
    err.ret !== undefined ||
    err.status === 429 ||
    (err.kind === 'http' && err.status >= 400 && err.status <= 499));
