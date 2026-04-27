const crypto = require('crypto');

/**
 * Generate an opaque player hash from a socket connection.
 * Raw IP is never stored -- only the hash is kept.
 */
function generatePlayerHash(socket) {
  const raw = socket.handshake.headers['x-forwarded-for']
    || socket.handshake.address
    || 'unknown';
  // Take first IP if comma-separated (proxy chain)
  const ip = raw.split(',')[0].trim().toLowerCase().replace(/^::ffff:/, '');
  return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
}

module.exports = { generatePlayerHash };
