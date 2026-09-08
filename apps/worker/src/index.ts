import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SeraEngine } from '@sera/engine';

/**
 * How a worker says it is alive.
 *
 * It has no HTTP surface by design, so it had been inheriting the API image's
 * healthcheck — an HTTP request to a port nothing listens on. That failed every thirty
 * seconds from the moment it started: 2,832 consecutive failures on the live deployment
 * while the worker was, in fact, completing every job it was given. A signal that is
 * always red is the same as no signal, and worse, because it hides the day something
 * genuinely breaks.
 *
 * Touching a file from the event loop answers the question that actually matters — not
 * "is the process present", which Docker already knows, but "is its loop still turning".
 * A wedged worker stops touching it and goes unhealthy within a minute.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

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

  const heartbeat = join(engine.config.dataDir, '.worker-alive');
  await writeFile(heartbeat, 'sera worker heartbeat\n').catch(() => undefined);
  const ticker = setInterval(() => {
    const now = new Date();
    void utimes(heartbeat, now, now).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  // Never the reason the process stays up.
  ticker.unref();

  const shutdown = (signal: string): void => {
    engine.logger.info({ signal }, 'draining worker');
    clearInterval(ticker);
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
