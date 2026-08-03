'use strict';

const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  logger.error(err.message, { stack: err.stack });
  const status = err.status || 400;
  res.status(status).json({
    error: err.message || 'Internal server error',
  });
};
