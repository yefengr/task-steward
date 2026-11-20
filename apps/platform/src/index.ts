import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.js';
import { originConfig } from './auth.js';
import { databasePath } from './config.js';
import { openStore } from './store.js';

function start(env: NodeJS.ProcessEnv) {
  const publicOrigin = env.STEWARD_PUBLIC_ORIGIN;
  const accessPasswordHash = env.STEWARD_ACCESS_PASSWORD_HASH;
  if (!publicOrigin || !accessPasswordHash) throw new Error('Missing platform authentication configuration');
  const allowLocalHttp = env.STEWARD_ALLOW_LOCAL_HTTP === '1';
  const { secure } = originConfig(publicOrigin, allowLocalHttp);
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid platform port');
  const hostname = secure ? '0.0.0.0' : new URL(publicOrigin).hostname === '[::1]' ? '::1' : '127.0.0.1';
  const store = openStore(databasePath(env));
  try {
    const app = createApp({ store, publicOrigin, accessPasswordHash, allowLocalHttp,
      trustProxyClientIp: env.STEWARD_TRUST_PROXY_CLIENT_IP === '1',
      peerIp: (context) => getConnInfo(context).remote.address,
      onInternalError: () => console.error('Platform request failed'),
    });
    const server = serve({ fetch: app.fetch, port, hostname }, () => console.log('Steward platform ready'));
    server.on('error', () => { console.error('Platform server failed'); process.exitCode = 1; store.connection.close(); });
    const shutdown = () => server.close(() => store.connection.close());
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    store.connection.close();
    throw error;
  }
}

try { start(process.env); } catch {
  console.error('Platform startup failed. Check authentication configuration, port and data directory.');
  process.exitCode = 1;
}
