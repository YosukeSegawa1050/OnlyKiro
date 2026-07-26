'use strict';

const os = require('node:os');

function getLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) {
        return item.address;
      }
    }
  }
  return 'localhost';
}

module.exports = { getLanAddress };
