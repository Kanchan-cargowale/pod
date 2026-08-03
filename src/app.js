'use strict';

const express = require('express');
const path = require('path');
const healthRoutes = require('./routes/health.routes');
const jobRoutes = require('./routes/job.routes');
const errorHandler = require('./middleware/errorHandler.middleware');

function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/health', healthRoutes);
  app.use('/api/jobs', jobRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
