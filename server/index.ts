import { createApp } from './app.js';
import { createDatabase, migrate } from './db.js';
import { seed } from './seed.js';
import { startWorker } from './worker.js';
import { config } from './config.js';
import { logger } from './errors.js';

const db = await createDatabase();
if (!config.production) {
  await migrate(db);
  await seed(db);
}
const app = createApp(db);
const server = app.listen(config.port, config.production ? '0.0.0.0' : '127.0.0.1', () =>
  logger.info({ port: config.port, database: db.kind }, 'SDP API ready'),
);
const worker = startWorker(db);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 15000);
  timeout.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await db.close();
  clearTimeout(timeout);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
