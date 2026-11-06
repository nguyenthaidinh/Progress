import { createRelay } from './server.mjs';
const port = Number(process.env.LIOOPS_RELAY_PORT || 4320), host = process.env.LIOOPS_RELAY_HOST || '127.0.0.1';
const { server } = createRelay({ adminToken: process.env.LIOOPS_RELAY_ADMIN_TOKEN, origins: (process.env.LIOOPS_WEB_ORIGINS || '').split(',').filter(Boolean) });
server.listen(port, host, () => console.log(`LioOps trial relay listening on ${host}:${port}; content logging disabled`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.closeAllConnections(); server.close(); });
