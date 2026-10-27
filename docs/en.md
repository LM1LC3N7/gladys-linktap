# LinkTap

Unofficial Gladys Assistant integration for the **LinkTap** water timers
(TapLinker, ValveLinker) paired with a LinkTap gateway (GW-02, GW-01), through
the **local HTTP API** of the gateway: no LinkTap cloud, no account. Not
affiliated with LinkTap.

**Never tested with a real device**: built from the Home Assistant
integration `linktap_local_http_component` (0.8.9) and the description of the
LinkTap protocol. Please report what works and what does not.

## What you get

One device per water timer, with:

- **Watering** (yes/no) and **Watering time left** (seconds);
- with a flow meter: **Flow** (m³/h) and **Volume of this watering** (litres;
  a gateway set to gallons is converted, US gallon);
- **Battery** (%), **Radio signal** (%), **Linked to the gateway**;
- **Watering plan paused**;
- the alerts: unusually high flow, unusually low flow, water cut off, timer
  fallen, valve failed to close;
- three buttons: **Start watering**, **Stop watering**, **Pause the watering
  plan**.

Watering is never a switch: a "turn everything on/off" of a voice assistant,
HomeKit or a scene on switches cannot open a valve.

A water timer the gateway no longer reaches by radio only publishes "Linked to
the gateway: no": its other values, kept by the gateway, are old.

## Setting up

1. Open the web page of the gateway (its IP address in your router) and
   enable its **Local HTTP API**. Firmware G609 or later for a GW-02, S609 for
   a GW-01.
2. Give the gateway a fixed IP address in your router.
3. In Gladys, open the integration, type the address, save.
4. Add the water timers from the **Discovery** tab.

The local API has no password and no https: any device of your local network
can use it. The gateway handles **one request at a time**: one integration
(Gladys, Home Assistant…) per gateway, and Gladys never sends two requests at
once.

## Reads

The gateway is read every 30 s by default (15 to 600 s), one request per water
timer, one after the other; never sooner, even after a restart, a
configuration saved or the "Check the gateway" button, except the reads that
follow a command (5, 15, 30 and 60 s after it). On a failure: tried
again after 30 s, 1, 2 then 5 minutes. When the gateway answers "busy" (HTTP
429 or 5xx, or its code 6 or 8), Gladys pauses for 1 minute to 6 hours, kept
across a restart; stops do not wait for it.

A water timer the gateway does not know, or whose answer is unreadable, does
not keep the others from being read. When another gateway answers at the
address, the status says so, and the commands of the timers of the previous
gateway are refused.

## Starting

- **Starting opens a valve: it is off by default.** Turn on **Allow starting
  a watering** to use the Start button. Otherwise the dashboard, the scenes and
  the voice assistants can only read, stop and pause the plan.
- The watering lasts the configured length (15 minutes by default, **120
  minutes at most**, a bound applied by Gladys); it is part of the command and
  the water timer closes the valve by itself at the end. Gladys never sends a
  watering by volume.
- Refused, nothing sent: the option off, the address of the configuration is
  not the one of the gateway of the timer, a pause asked by the gateway, the
  file `/data/linktap.json` unreadable or the start impossible to record in it,
  another command of the same timer waiting, or a start of the same timer that
  left less than a minute ago and is not seen on a read yet ("try again in a
  minute").
- The gateway handles one request at a time: a start behind other requests (a
  scene starting five timers) may leave up to 10 s after the click; Gladys
  then answers "queued". A stop of the same timer cancels it as long as it has
  not left.
- A success is answered only when a read made after it shows the timer
  watering; otherwise "sent, without confirmation", then reads at 5, 15, 30
  and 60 s.

## Stopping

Stopping needs no permission and is **never held** by the option, a pause of
the gateway, a recent start, a configuration Gladys has not given yet, nor by
a read in progress: the stop goes ahead of every other request; the request
in flight is cut to let it leave when it has been silent for 1 s, or the stop
has waited 1.5 s. It cancels the start of
the same timer not sent yet. Right after a restart, a stop works even before
Gladys gives the configuration.

The stop is **refused unsent** only:

- when this integration never read the water timer (it is not known);
- when the gateway of the timer has no known address any more (another
  gateway answered at its address).

It is **sent then refused by the gateway** when the gateway does not know the
timer (nothing to stop), or answers another error (format, parameter, command
not supported).

When it **cannot leave** (no connection, a busy gateway, HTTP 404), it is
tried again 250 ms later within its 3 s; when it is still not taken (or
another gateway answers at the address), Gladys sends it again at 5, 15, 30
and 60 s (even during a pause) and after a restart, 3 times at most in all.

After a stop taken by the gateway, a read still showing the timer watering
(more than 4 s after) sends it again, 3 times at most. The watch of a stop is
lifted only by a read showing the timer stopped followed by a watering started
elsewhere (the app, the button, the plan) read twice in a row, or by a start
from Gladys that leaves: **never by the time alone**. The status tells a
watering that goes on after three resends.

## Pausing the plan

The button pauses the watering plan of the timer for the configured length
(24 h by default, 1 to 240 h). It does not need the start option. Gladys reads
the timer first: already paused, nothing is sent (a second pause can switch
the plan off, a known LinkTap issue); state unreadable, timer not linked, a
pause asked by the gateway, or the address of the configuration not the one
of its gateway: refused, nothing sent. Resuming the plan is done in the LinkTap app.

## "Check the gateway" button

Shows the id of the gateway, its firmware, the number of water timers and the
age of the last read, or the last error. It never reads sooner than the
interval.

## The /data file

`/data/linktap.json` keeps the gateway and its water timers, the pause asked
by the gateway, the starts and stops being watched and the time of the last
read. No secret: the local API has none. When it exists but cannot be read,
Gladys writes nothing to it any more (it is never overwritten), refuses the
starts and keeps reading and stopping.
