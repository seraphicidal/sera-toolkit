import {
  createLogger,
  JobRunner,
  loadConfig,
  MediaResolver,
  ProviderRegistry,
  WorkspaceManager,
} from '@sera/engine';
import { ExtractionNode } from './node.js';

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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
