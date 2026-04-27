/**
 * Server configuration utilities
 */

/**
 * Format base path for Express routing
 */
function formatBasePath(value) {
  if (!value || typeof value !== 'string') {
    return '/';
  }

  let cleaned = value.trim();

  if (!cleaned.startsWith('/')) {
    cleaned = `/${cleaned}`;
  }

  cleaned = cleaned.replace(/\/{2,}/g, '/');

  if (cleaned.length > 1 && cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }

  return cleaned || '/';
}

/**
 * Build Socket.IO path from base path
 */
function buildSocketPath(basePath) {
  const prefix = basePath === '/' ? '' : basePath;
  return `${prefix}/socket.io`;
}

/**
 * Register config route for client
 */
function registerConfigRoute(appRef, basePath, socketPath) {
  const route = basePath === '/' ? '/config.js' : `${basePath}/config.js`;
  const exposedPath = basePath === '/' ? '/' : basePath;

  appRef.get(route, (_req, res) => {
    const script = [
      `window.CHESS_BASE_PATH=${JSON.stringify(exposedPath)};`,
      `window.CHESS_SOCKET_PATH=${JSON.stringify(socketPath)};`,
    ].join('');
    res.type('application/javascript').send(script);
  });
}

module.exports = {
  formatBasePath,
  buildSocketPath,
  registerConfigRoute,
};
