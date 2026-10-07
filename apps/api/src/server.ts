import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { SeraEngine } from '@sera/engine';
import { clientKeyPlugin } from './plugins/client.js';
import { errorHandlerPlugin } from './plugins/errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerExtractionNodeRoutes } from './routes/extraction-node.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerMetaRoutes } from './routes/meta.js';

export async function buildServer(engine: SeraEngine): Promise<FastifyInstance> {
  const { config } = engine;

  const app = Fastify({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: engine.logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    routerOptions: { maxParamLength: 4096 },
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 0,
    keepAliveTimeout: 72_000,
  });

  await app.register(errorHandlerPlugin);
  await app.register(clientKeyPlugin, { engine });

  await app.register(cors, {
    origin: config.corsOrigins.length ? [...config.corsOrigins] : false,
    methods: ['GET', 'POST', 'DELETE'],
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
  registerExtractionNodeRoutes(app, engine);
  registerAdminRoutes(app, engine);

  return app;
}
