# Third-party notices

This integration ports to JavaScript the knowledge of the LinkTap local HTTP
API held by the following project: the endpoint (`POST /api.shtml` with a JSON
body), the commands it sends (3 status, 6 instant watering, 7 stop, 16 gateway
configuration, 18 pause of the watering plan), the way the gateway id is
learned (a status request without ids), the answers wrapped in HTML by older
firmwares, the fields of the status, and the caution about a second pause of
the plan. No file is copied, and nothing of it is installed at runtime; its
notice is reproduced below as required by its license.

## linktap_local_http_component

<https://github.com/sh00t2kill/linktap_local_http_component> (the Home
Assistant custom integration, HACS), version 0.8.9

```
MIT License

Copyright (c) 2026 sh00t2kill

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Facts read elsewhere (no code ported)

- The `ret` codes of the gateway (0 to 9), the bounds of the commands (an
  instant watering of 3 to 86 340 s, a pause of 0.1 to 240 h), the `vol_unit`
  values (`L`, `gal`), the `dev_stat` form of a status and the advice to keep
  one request in flight at a time were read in the LinkTap binding of openHAB
  (<https://github.com/openhab/openhab-addons>, `bundles/org.openhab.binding.linktap`,
  EPL-2.0), which documents the LinkTap protocol. Nothing of its code is
  copied or translated.
