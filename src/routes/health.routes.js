'use strict';

const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: process.uptime() });
});

module.exports = router;
