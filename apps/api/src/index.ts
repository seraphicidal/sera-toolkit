import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { SeraEngine } from '@sera/engine';
import { buildServer } from './server.js';

/**
 * Development configuration is loaded here rather than through `--env-file`.
 *
 * npm runs a workspace script from the directory the command was typed in, not from the
 * package, so a relative env path silently resolves somewhere else depending on how the
 * server was started. Resolving it from this module's own location removes the guess.
 * Production is configured by real environment variables, so the file is ignored there.
 */
function loadDevEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  const envPath = join(import.meta.dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  loadEnvFile(envPath);
  console.warn(`[sera] loaded ${envPath}`);
}

/**
 * API entrypoint.
 *
 * When the queue driver is `memory` the API also runs the worker, which is the common
 * single-container deployment. With the Redis driver, `SERA_EMBEDDED_WORKER=false` keeps
 * this process serving HTTP while `@sera/worker` does the media work elsewhere.
 */
async function main(): Promise<void> {
  loadDevEnv();
  const engine = await SeraEngine.create();
  const app = await buildServer(engine);

  if (engine.config.embeddedWorker) engine.startWorker();

  const shutdown = (signal: string): void => {
    engine.logger.info({ signal }, 'shutting down');
    void (async () => {
      // Stop accepting connections first so in-flight downloads can finish streaming.
      await app.close().catch(() => undefined);
      await engine.close().catch(() => undefined);
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: engine.config.host, port: engine.config.port });
  engine.logger.info(
    {
      port: engine.config.port,
      queue: engine.backend.driver,
      worker: engine.config.embeddedWorker ? 'embedded' : 'external',
    },
    'SERA.toolkit API listening',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
