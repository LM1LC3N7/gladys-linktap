// -----------------------------------------------------------------------------
// Entry point of the container: SDK wiring only (src/handlers.js registers
// every handler BEFORE connect(), and delegates to the LinkTapApp of
// src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { LinkTapApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new LinkTapApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.stop());

// The stops not taken before a restart leave now, before Gladys answers.
app.boot().catch((err) => logger.error('Reading /data failed', err));

logger.info('Starting the LinkTap integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
