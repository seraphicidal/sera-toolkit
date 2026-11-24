import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { SeraEngine } from '@sera/engine';
import { clientKeyPlugin } from './plugins/client.js';
import { errorHandlerPlugin } from './plugins/errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerExtractionNodeRoutes } from './routes/extraction-node.js';
import {
  createExtractionUpdatesService,
  registerExtractionUpdateRoutes,
} from './routes/extraction-updates.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerLegalRoutes } from './routes/legal.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerMetaRoutes } from './routes/meta.js';

export async function buildServer(engine: SeraEngine): Promise<FastifyInstance> {
  const { config } = engine;

  const trustProxy =
    typeof config.trustProxy === 'number'
      ? (_address: string, hop: number) => hop <= (config.trustProxy as number)
      : config.trustProxy;

  const requestTimeout = config.extractionNodes.enabled
    ? Math.min(Math.max(60_000, config.jobTimeoutSeconds * 1000), 15 * 60_000)
    : 60_000;

  const app = Fastify({
    loggerInstance: engine.logger as FastifyBaseLogger,
    trustProxy,
    bodyLimit: 256 * 1024,
    routerOptions: { maxParamLength: 4096 },
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout,
    keepAliveTimeout: 72_000,
  });

  app.server.headersTimeout = 15_000;

  app.addHook('onRequest', (request, reply, done) => {
    if (
      request.routeOptions.url !== '/internal/extraction/:taskId/file' &&
      !request.raw.complete &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.method !== 'OPTIONS'
    ) {
      let cleared = false;
      const clear = () => {
        if (cleared) return;
        cleared = true;
        clearTimeout(timer);
        request.raw.removeListener('end', clear);
        request.raw.removeListener('close', clear);
        request.raw.removeListener('error', clear);
        reply.raw.removeListener('finish', clear);
      };
      const timer = setTimeout(() => {
        clear();
        if (!request.raw.complete && !request.raw.destroyed) {
          request.raw.destroy(new Error('Request body timeout'));
        }
      }, 30_000);
      timer.unref();
      request.raw.once('end', clear);
      request.raw.once('close', clear);
      request.raw.once('error', clear);
      reply.raw.once('finish', clear);
    }
    done();
  });

  await app.register(errorHandlerPlugin);
  await app.register(clientKeyPlugin, { engine });

  await app.register(cors, {
    origin: config.corsOrigins.length ? [...config.corsOrigins] : false,
    methods: ['GET', 'POST', 'DELETE', 'HEAD'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.clientKey,
    allowList: (request) => request.canary,
    addHeaders: { 'retry-after': true, 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    if (!reply.getHeader('content-security-policy')) {
      void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    request.log.debug(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request',
    );
    done();
  });

  registerMetaRoutes(app, engine);
  registerMediaRoutes(app, engine);
  registerJobRoutes(app, engine);
  const updates = config.extractionNodes.enabled
    ? createExtractionUpdatesService(engine)
    : undefined;
  registerExtractionNodeRoutes(app, engine, updates);
  if (updates) registerExtractionUpdateRoutes(app, engine, updates);
  registerAdminRoutes(app, engine);
  registerLegalRoutes(app, engine);

  return app;
}
