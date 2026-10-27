# TODO

## To confirm on a real gateway

- [ ] The answer of cmd 3 on the local HTTP API: flat (as the Home Assistant
      integration reads it) or under `dev_stat` (as the LinkTap protocol
      describes it)? Both are read; is `dev_id` always in it?
- [ ] The probe (cmd 3 without ids) answers with `gw_id` on the current
      firmwares (the Home Assistant integration relies on it)?
- [ ] `is_paused` is in the status of the current firmwares (the Home
      Assistant integration reads it; the openHAB binding does not list it)?
- [ ] A gateway set to gallons: US gallons (assumed: 3.785 L)? `speed` in
      gal/min then?
- [ ] Does the gateway answer cmd 3 from its memory (fast) or by radio? The
      request timeout is 3 s, the reads one at a time.
- [ ] Does cmd 7 also stop a watering of the plan or of the manual button
      (the protocol says the plan resumes at its next slot)?
- [ ] How long between the answer of cmd 6/7 and the status showing it (the
      radio): the confirmation read waits 1.2 s, a resend waits 4 s.
- [ ] Does the gateway close a connection cut by the client at once (the
      lane waits for the close + 50 ms)?
- [ ] The `Server` header of the gateway (the openHAB binding checks it): it
      could tell a LinkTap gateway from another device.

## Later

- [ ] Resume the watering plan (a start in effect: off by default).
- [ ] Dismiss an alert (cmd 11), child lock (cmd 12).
- [ ] Watering by volume (bounded), per-timer lengths.
- [ ] Several gateways (one address each).
- [ ] Scene actions (water a timer for N minutes), dashboard widget.
- [ ] Keywords and countries of the store catalog, once the store takes them.

## Decisions

- Version 0.1.0 set by hand in package.json, package-lock.json, the manifest
  and the `docker_image` tag; the first Release (patch) gives 0.1.1.
- SDK 0.16.0 (the latest, checked on 2026-10-27).
- Reference ported: linktap_local_http_component 0.8.9 (MIT, sh00t2kill),
  checked in its LICENSE. The LinkTap protocol facts (ret codes, bounds,
  `dev_stat`, one request at a time) read in the openHAB binding (EPL-2.0):
  facts only, no code. Neighbours followed: LM1LC3N7/gladys-yardian (the
  domain, local HTTP, buttons), gladys-rachio.
- Identity: the gateway id (`gw_id`, 16 letters or digits) learned by a
  status request without ids, then sent in every request: the gateway refuses
  a request meant for another one (`ret` 3), so a command never reaches
  another gateway. External ids: `linktap:<timer id>` (the `end_dev` id,
  upper case, `_<n>` kept for a sub-device). Feature keys: `watering`,
  `remaining`, `flow`, `volume`, `battery`, `signal`, `rf_linked`,
  `plan_paused`, `alert_high_flow`, `alert_low_flow`, `alert_water_cut`,
  `alert_fall`, `alert_valve_failure`, `start`, `stop`, `pause_plan`.
- Units: flow in m³/h (`water-valve/flow`, the only unit Gladys gives it),
  from L/min × 0.06; volume in litres (`real-time-irrigation-volume`); gallons
  converted (US gallon). Without a known `vol_unit`, no flow nor volume.
- One request at a time per address (`src/linktap/lane.js`): stops first,
  then commands, then reads; a stop cuts the request in flight silent for 1 s
  or after 1.5 s of waiting; a failed request settles only once its socket is
  closed (+50 ms).
- Start = sensitive: off by default, checked on arrival, at its turn and in
  `beforeSend`; length from the configuration, 1 to 120 min, capped in the
  code; guard on disk (awaited, else refused) before the first byte, 60 s, or
  until a read sent after it shows watering; no read before the start (the
  gateway checks the ids; a timer already watering only gets its run set to
  the bounded length). Queued at the ack (3.4 s): may leave until 10 s after
  the click, cancelled by a stop of its timer.
- Stop = protective: never held by the option, a pause, the guards, a
  missing configuration or a read in flight; sent from /data at boot when not
  taken before; retried 250 ms later within 3 s; then follow-ups and reads,
  3 resends at most per stop (counted in /data). The stop guard is never
  lifted by time: only a dry read then a watering read twice in a row, or a
  start from Gladys whose request leaves.
- Pause of the plan: decided on a status read just now; already paused:
  nothing sent (LinkTap issue #88 of the reference: a second pause switches
  the plan off); not gated by the start option.
- Reads never sooner than the interval (default 30 s, 15 to 600 s): the time
  of the last try is in /data before the read. 429, 5xx, `ret` 6/8: a pause
  of 1 min to 6 h, persisted, on the monotonic clock in memory.
- The commands answer within 3.4 s (Gladys gives up after 5 s): success only
  on a read showing the effect; otherwise "sent, without confirmation",
  "queued" or "not sent".
- `getConfig()` failing in `connected`: tried again after 5, 15, 30 s, then
  every minute, without end, with its status.
- Docker and `gi install` are run by `gi ci` on this VM.
