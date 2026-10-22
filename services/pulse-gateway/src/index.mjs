import { loadConfig } from './config.mjs';
import { createServer } from './gateway.mjs';

let config;
try { config = loadConfig(); }
catch { console.error('Invalid gateway configuration. Check the documented server environment; secret values are not printed.'); process.exit(1); }
const server = createServer(config);
server.listen(config.port, config.host, () => console.info('Pulse gateway listening on private loopback.'));
server.on('error', () => { console.error('Gateway listener failed.'); process.exitCode = 1; });
function shutdown() {
  server.close(() => { process.exitCode = 0; });
  setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
