# gladys-linktap

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**LinkTap** water timers (TapLinker, ValveLinker), through the **local HTTP
API** of their gateway (GW-02, GW-01): no cloud, no account. Not affiliated
with LinkTap.

**Never tested with a real device.** Built from the Home Assistant integration
`linktap_local_http_component` 0.8.9 (MIT, see `THIRD_PARTY_NOTICES.md`).

- One device per water timer: watering, time left, flow and volume (with a
  flow meter), battery, radio signal, radio link, plan paused, five alerts.
- Buttons, never a switch: **Start** (off by default, a length of 120 minutes
  at most, carried by the command), **Stop** (never held, ahead of every
  request), **Pause the watering plan**.
- One request at a time to the gateway, reads never sooner than the interval.

User guide: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test             # node --test (Node 22 and 24)
npm run lint
npm run format:check
npm run cover        # regenerates cover.png
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md).

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
