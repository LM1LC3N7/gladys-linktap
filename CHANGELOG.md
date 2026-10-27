# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- LinkTap water timers (TapLinker, ValveLinker) through the local HTTP API of
  the gateway (GW-02, GW-01): watering, time left, flow and volume with a flow
  meter, battery, radio signal and link, plan paused, alerts.
- Start (off by default, 120 minutes at most), stop (never held, ahead of
  every request, sent again until taken) and pause of the watering plan
  buttons; one request at a time to the gateway.
- "Check the gateway" button; guides in French and English.

[Unreleased]: https://github.com/LM1LC3N7/gladys-linktap/commits/main
