import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SeraEngine } from '@sera/engine';

const HEARTBEAT_INTERVAL_MS = 15_000;

async function main(): Promise<void> {
  const engine = await SeraEngine.create();

  if (engine.backend.driver !== 'redis') {
    engine.logger.error(
      { driver: engine.backend.driver },
      'a standalone worker needs SERA_QUEUE_DRIVER=redis; with the memory driver the API runs its own worker',
    );
    process.exit(1);
  }

  const handle = engine.startWorker();

  const heartbeat = join(engine.config.dataDir, '.worker-alive');
  await writeFile(heartbeat, 'sera worker heartbeat\n').catch(() => undefined);
  const ticker = setInterval(() => {
    const now = new Date();
    void utimes(heartbeat, now, now).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  ticker.unref();

  const shutdown = (signal: string): void => {
    engine.logger.info({ signal }, 'draining worker');
    clearInterval(ticker);
    void (async () => {
      await handle.close().catch(() => undefined);
      await engine.close().catch(() => undefined);
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  engine.logger.info(
    { concurrency: engine.config.workerConcurrency, queue: engine.backend.driver },
    'SERA.toolkit worker ready',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
