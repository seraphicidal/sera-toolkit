import { SeraEngine } from '@sera/engine';

/**
 * Worker entrypoint.
 *
 * Runs the media pipeline and nothing else: no HTTP surface, no public port. Scale it by
 * running more of these against the same Redis and the same storage volume. With the
 * memory driver a standalone worker has nothing to pull from, so it refuses to start
 * rather than idling forever and looking healthy.
 */
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

  const shutdown = (signal: string): void => {
    engine.logger.info({ signal }, 'draining worker');
    void (async () => {
      // Let in-flight jobs finish before the process goes away.
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
