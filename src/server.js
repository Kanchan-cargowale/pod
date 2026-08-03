'use strict';

const createApp = require('./app');
const config = require('./config');
const logger = require('./utils/logger');
const storage = require('./services/storage.service');
const jobService = require('./services/job.service');

async function main() {
  await storage.ensureDirs();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`Courier Label Editor listening on port ${config.port}`, {
      workerPoolSize: config.workerPoolSize,
    });
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    server.close();
    await jobService.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error', err);
  process.exit(1);
});
