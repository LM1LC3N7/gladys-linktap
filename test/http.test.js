// -----------------------------------------------------------------------------
// The real transport against real local servers (127.0.0.1 only, testkit):
// answers raw or wrapped in HTML, oversized bodies cut before the end, a
// gateway that never answers, a refused port, and the lane: a stop cuts a
// silent read and never overlaps it (one connection at a time).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { blackhole, httpServer, refusePort, reply } from './kit/index.mjs';
import { LinkTapClient } from '../src/linktap/client.js';
import { GatewayLane, PRIORITY } from '../src/linktap/lane.js';
import { GW, TAP1, gatewayBrain } from './helpers/gateway.js';

const client = new LinkTapClient();
const options = { timeout: 1500 };

test('raw JSON and HTML-wrapped answers; the body is the JSON posted to /api.shtml', async (t) => {
  const brain = gatewayBrain();
  const srv = await httpServer({ routes: { 'POST /api.shtml': (r) => brain.handle(r.json) } });
  t.after(() => srv.close());
  const target = { host: '127.0.0.1', port: srv.port };
  const status = await client.status(target, GW, TAP1, options);
  assert.equal(status.is_watering, false);
  assert.deepEqual(srv.requests[0].json, { cmd: 3, gw_id: GW, dev_id: TAP1 });
  assert.match(srv.requests[0].headers['content-type'], /application\/json/);
  srv.routes['POST /api.shtml'] = () =>
    reply(
      200,
      `<html><head><title>api</title></head><body>api${JSON.stringify({ cmd: 7, gw_id: GW, dev_id: TAP1, ret: 0 })}api</body></html>`,
      {
        'content-type': 'text/html',
      },
    );
  const stopped = await client.stop(target, GW, TAP1, options);
  assert.equal(stopped.ret, 0);
});

test('an answer to another request, another gateway, a non-zero ret: refused', async (t) => {
  const srv = await httpServer({
    routes: { 'POST /api.shtml': { cmd: 6, gw_id: GW, dev_id: TAP1, ret: 0 } },
  });
  t.after(() => srv.close());
  const target = { host: '127.0.0.1', port: srv.port };
  await assert.rejects(client.stop(target, GW, TAP1, options), { kind: 'invalid', sent: true });
  srv.routes['POST /api.shtml'] = { cmd: 7, gw_id: 'FFFF000011112222', ret: 0 };
  await assert.rejects(client.stop(target, GW, TAP1, options), { kind: 'otherGateway' });
  srv.routes['POST /api.shtml'] = { cmd: 7, gw_id: GW, ret: 8 };
  await assert.rejects(client.stop(target, GW, TAP1, options), { kind: 'busy', ret: 8 });
  srv.routes['POST /api.shtml'] = { cmd: 7, gw_id: GW, ret: 5 };
  await assert.rejects(client.stop(target, GW, TAP1, options), { kind: 'unknownTimer' });
  srv.status5xx = 1;
  await assert.rejects(client.stop(target, GW, TAP1, options), { kind: 'busy', status: 503 });
});

test('an oversized answer is cut before it is read whole', async (t) => {
  const srv = await httpServer({ routes: { 'POST /api.shtml': { cmd: 3 } }, bigBody: 200 * 1024 });
  t.after(() => srv.close());
  await assert.rejects(client.status({ host: '127.0.0.1', port: srv.port }, GW, TAP1, options), {
    kind: 'tooLarge',
  });
});

test('silent gateway: timeout, sent; refused port: unreachable, not sent', async (t) => {
  const hole = await blackhole();
  t.after(() => hole.close());
  await assert.rejects(
    client.stop({ host: '127.0.0.1', port: hole.port }, GW, TAP1, { timeout: 300 }),
    {
      kind: 'timeout',
      sent: true,
    },
  );
  const port = await refusePort();
  await assert.rejects(client.stop({ host: '127.0.0.1', port }, GW, TAP1, { timeout: 300 }), {
    kind: 'unreachable',
    sent: false,
  });
});

test('the lane: a stop cuts a silent read, waits for its socket to close, never two connections', async (t) => {
  const brain = gatewayBrain();
  let open = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (payload.cmd === 3) return; // a read that never answers
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(brain.handle(payload)));
    });
  });
  server.on('connection', (socket) => {
    open += 1;
    peak = Math.max(peak, open);
    socket.on('close', () => {
      open -= 1;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const target = { host: '127.0.0.1', port: server.address().port };
  const lane = new GatewayLane({
    monotonic: () => performance.now(),
    timers: globalThis,
    stallCut: 300,
    protectiveWait: 1500,
  });
  const read = lane.run(
    (ctx) =>
      client.status(target, GW, TAP1, {
        timeout: 5000,
        signal: ctx.signal,
        onActivity: ctx.activity,
      }),
    { priority: PRIORITY.READ },
  );
  await new Promise((r) => setTimeout(r, 50));
  const started = performance.now();
  const stop = lane.run(
    (ctx) =>
      client.stop(target, GW, TAP1, {
        timeout: 2000,
        signal: ctx.signal,
        onActivity: ctx.activity,
      }),
    { priority: PRIORITY.PROTECTIVE },
  );
  await assert.rejects(read, { kind: 'cut' });
  const answer = await stop;
  assert.equal(answer.ret, 0);
  assert.ok(performance.now() - started < 1200, 'the stop left within the stall cut');
  assert.equal(peak, 1);
  assert.equal(brain.count(7, TAP1), 1);
});
