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
- [ ] ECO mode: a dry read during an "off" segment counts as dry for a stop
      guard; `is_final` or `remain_duration` could tell (review 1, m8).
- [ ] `remain_duration`: counted live when cmd 3 arrives, or the value of the
      last radio report (cached)? The age proof (a run younger than the stop
      is another run) assumes a live count: a cached time left makes the
      stopped run look younger than it is, and the 1.5 s margin only covers a
      rounding to the second (review 3).
- [ ] The `Server` header of the gateway (the openHAB binding checks it): it
      could tell a LinkTap gateway from another device.

## Later

- [ ] Resume the watering plan (a start in effect: off by default).
- [ ] Dismiss an alert (cmd 11), child lock (cmd 12).
- [ ] Watering by volume (bounded), per-timer lengths.
- [ ] Several gateways (one address each).
- [ ] Scene actions (water a timer for N minutes), dashboard widget.
- [ ] Keywords and countries of the store catalog, once the store takes them.
- [ ] The age proof is unused without a run read before the click (`lastRun`
      empty at the stop): the first watering read after the click becomes the
      reference unproven, so a run started elsewhere just after the stop and
      seen by that first read is cut by a resend (the safe side). Testing its
      age before taking it as the reference would spare it (review 3).

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
  until a read sent after the click shows watering; decided on a status read
  just now (already watering: nothing sent; unreadable or unlinked: refused).
  Queued at the ack (3.4 s): may leave until 10 s after the click, cancelled
  by a stop of its timer; a queued start that does not leave is told in the
  status (review 1, I5). The configuration received applies to the commands
  at once, never after a read in progress (review 1, B2).
- Stop = protective: never held by the option, a pause, the guards, a
  missing configuration or a read in flight; sent from /data at boot when not
  taken before; retried 250 ms later within 3 s; then every 10 s (every
  minute after 5 minutes) and at every read reaching the gateway, without
  end until taken, never counted (an answer proving nothing was applied is
  not a resend, review 2 B1). A taken stop whose same run still waters is
  resent 3 times at most, each counted once (taken, or left unanswered). Only readings sent after the
  click decide (request numbers, review 1, I1), each timed from the
  departure of its request, never its answer (the gateway measures during
  the request, up to 3 s before answering; review 3, I1): the resend of a
  taken stop waits for a read sent 4 s after the take. A resend targets only
  the run seen at the stop: another run, proven by `total_duration` changed,
  `remain_duration` grown, or an elapsed time more than 1.5 s shorter than
  the time from the click to the departure of the read (only once the
  gateway was seen counting down), read twice in a row lifts the guard. In
  doubt the stop wins, said in the docs (review 2, I1).
  The stop guard is never lifted by time: a dry read then a watering read
  twice in a row, another run read twice in a row, a start from Gladys with
  the option (sent, or finding the timer watering), or `ret` 4/5.
- Pause of the plan: decided on a status read just now; already paused, or
  `is_paused` missing: nothing sent (LinkTap issue #88 of the reference: a
  second pause switches the plan off); a pause guard on disk before the first
  byte refuses another one until a read sent after it shows the plan paused,
  10 min at most (review 1, I3); not gated by the start option.
- One request at a time, by priority: stops, then the request of a start or
  pause once decided, then the reads deciding or confirming a command, then
  the polling. A confirmation read that lost its race leaves the queue.
- cmd 16 is secondary once the timers are known, transport failures
  included: the read stops only if the first timer fails the same way
  (review 1, I4). Every timer failing is not "connected" (m3).
- Equivalent mutants kept, the checks on purpose: "stop acked only for the
  same guard" (an orphan guard marked acked changes nothing); "a taken stop
  keeps its spacing" and "the cap of 3 also without a take" (the spacing
  only applies to a guard not taken, which never becomes not taken again;
  `resends` only grows once taken) (reviews 2 and 3).
- A value is as old as the departure of its read: a device created later
  gets it only within two intervals of that (review 3).
- Reads never sooner than the interval (default 30 s, 15 to 600 s): the time
  of the last try is in /data before the read. 429, 5xx, `ret` 6/8: a pause
  of 1 min to 6 h, persisted, on the monotonic clock in memory.
- The commands answer within 3.4 s (Gladys gives up after 5 s): success only
  on a read showing the effect; otherwise "sent, without confirmation",
  "queued" or "not sent".
- `getConfig()` failing in `connected`: tried again after 5, 15, 30 s, then
  every minute, without end, with its status.
- Docker and `gi install` are run by `gi ci` on this VM.
