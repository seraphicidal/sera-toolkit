import {
  createLogger,
  JobRunner,
  loadConfig,
  MediaResolver,
  ProviderRegistry,
  WorkspaceManager,
} from '@sera/engine';
import { ExtractionNode } from './node.js';

/**
 * Starts an extraction node from the environment. What a node is, and why it exists, is
 * in `node.ts`.
 *
 *   SERA_API_URL=https://your-deployment
 *   SERA_EXTRACTION_NODE_TOKEN=<the same secret the API has>
 *   SERA_NODE_ID=laptop          (optional; default residential, one per machine)
 *   SERA_NODE_PROVIDERS=youtube  (optional; empty means every provider)
 *   SERA_NODE_NETWORK_CLASS=residential  (optional; datacenter for a second cloud node)
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    pretty: !config.isProduction,
    name: 'sera-node',
  });

  const registry = new ProviderRegistry();
  const resolver = new MediaResolver({ config, logger, registry });
  const workspaces = new WorkspaceManager(config.dataDir, config.retentionSeconds, logger);
  const runner = new JobRunner({ config, logger, resolver, workspaces });

  const node = new ExtractionNode(
    {
      apiUrl: process.env.SERA_API_URL ?? '',
      token: process.env.SERA_EXTRACTION_NODE_TOKEN ?? '',
      nodeId: process.env.SERA_NODE_ID ?? 'residential',
      networkClass: process.env.SERA_NODE_NETWORK_CLASS ?? 'residential',
      providers: (process.env.SERA_NODE_PROVIDERS ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    },
    logger,
    config,
    registry,
    resolver,
    runner,
    workspaces,
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'stopping extraction node');
    node.stop();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await node.run();
}

// The same last word as the API and the worker, so a failed start reads alike in every log.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
