'use strict';

/**
 * Wraps an async express handler so rejected promises are forwarded to
 * the error-handling middleware instead of crashing the process.
 */
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
