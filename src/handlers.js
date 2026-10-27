// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the known water timers are published at every start and change.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands (start, stop and pause buttons).
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.CHECK, () => app.checkGateway());

  // Configuration saved by the user (one at a time, the last one wins).
  gladys.onConfigUpdated((config) => app.start(config));

  // Connection lifecycle (also after every reconnection to Gladys): the
  // status and the Discovery tab are published again; the gateway is read
  // only when due. A failing getConfig() is tried again without end.
  gladys.on('connected', () => {
    app.connected(() => gladys.getConfig()).catch((err) => logger?.error('Start failed', err));
  });
}
