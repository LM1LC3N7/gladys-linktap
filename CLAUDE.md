# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16). It reads
the **LinkTap** water timers (TapLinker, ValveLinker) through the local HTTP
API of their gateway (GW-02, GW-01: `POST /api.shtml`, JSON, no secret) and
exposes each timer as a Gladys device, with start, stop and pause buttons.
Unofficial: not affiliated with LinkTap. Ported from
linktap_local_http_component 0.8.9 (MIT), see THIRD_PARTY_NOTICES.md.

## Commands

```bash
npm install
npm test                                  # node --test (60 s per test at most)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # regenerates cover.png (800×534)
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit. The tests
must pass on Node 22 and 24 (the CI runs both).

## Architecture

```
index.js                SDK wiring only (+ app.boot(): stops not taken leave at once)
src/handlers.js         the SDK handlers (shared with the tests)
src/app.js              LinkTapApp: reads, devices, status, start / stop / pause, Check button
src/linktap/lane.js     one request at a time per gateway, stops first, cut of a silent request
src/linktap/client.js   the commands (3, 6, 7, 16, 18), ret codes, answers checked against the request
src/linktap/http.js     the only network access (node:http, deadline, size cap, beforeSend)
src/linktap/parse.js    answers -> configuration, status of a timer (pure, strict)
src/linktap/errors.js   LinkTapError kinds
src/model.js            the Gladys devices, feature keys, values (pure)
src/store.js            /data: gateways, timers, pause, guards, last read
src/publisher.js        states within 300/min
src/config.js           config_schema normalized
src/constants.js        API facts, limits, timings, manifest keys
src/i18n.js             runtime texts (en/fr)
test/helpers/           the gateway (state machine + transport on a virtual clock)
```

## Rules

- **Unofficial.** Every user-facing surface says it. Never use the LinkTap
  logo.
- **Keys are forever**: manifest keys, the external id type (`linktap`), the
  identity rule (the timer id of `end_dev`, upper case), feature keys
  (`src/model.js`). Never rename them.
- **One request at a time to a gateway**: every request goes through
  `GatewayLane` (`src/app.js` `request()`); never call the client directly.
- **Starting opens a valve**: off by default, never a switch, decided on a
  status read just now, option checked again in `beforeSend`, length capped
  in the code (120 min). **Stopping is never held** by the option, a pause,
  the guards, a missing configuration or a request in flight; the few cases
  where it is refused unsent are listed in the docs and in the header of
  `src/app.js`, and must stay documented exactly. A stop guard is never
  lifted by the time alone.
- **Never read sooner than the interval** (restart included); 429/5xx and a
  busy gateway are persisted, never retried in a loop.
- **Clocks**: `monotonic` for every decision (pauses, guards, deadlines),
  `now` only for /data. Tests use the testkit clock that moves at every read.
- **Built blind**: no gateway was available. Every command lives in
  `src/linktap/client.js`, every field name in `src/linktap/parse.js`;
  `TODO.md` lists what to confirm.
- **Read-only rootfs**: write nothing outside /data.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag
  (0.1.0 was set once by hand).
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` kept in
  sync.
- **Tests never touch the network** except `test/http.test.js` and
  `test/realclock.test.js` (local servers on 127.0.0.1).

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
