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

  const registry = new ProviderRegistry(undefined, config);
  const resolver = new MediaResolver({ config, logger, registry });
  const workspaces = new WorkspaceManager(config.dataDir, config.retentionSeconds, logger);
  await workspaces.reap();
  const stopReaper = workspaces.startReaper(config.reapIntervalSeconds);
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

  let shuttingDown = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'stopping extraction node');
    node.stop();
    forceTimer = setTimeout(() => process.exit(0), 8_000);
    forceTimer.unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await node.run();
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    stopReaper();
    await resolver.close().catch(() => undefined);
    await registry.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
