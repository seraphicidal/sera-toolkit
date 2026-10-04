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

/**
 * Builds the HTTP surface.
 *
 * Returned rather than started, so tests can drive the whole API through `inject()`
 * without binding a port — which is what makes the download pipeline testable end to
 * end rather than only in pieces.
 */
export async function buildServer(engine: SeraEngine): Promise<FastifyInstance> {
  const { config } = engine;

  const app = Fastify({
    // Widened to Fastify's own logger interface. The assertion looks redundant to
    // eslint, which checks assignability, but it is what stops Fastify inferring its
    // logger generic from the concrete pino type — which specialises every route and
    // makes this instance unassignable to a plain FastifyInstance.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: engine.logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    // Bodies are a URL and a handful of ids; anything larger is not a real request.
    bodyLimit: 64 * 1024,
    // Signed handles travel as route parameters and are far longer than the router's
    // 100-character default, which rejects them with a 414 before any handler runs. A
    // thumbnail token carrying a long CDN URL is around 150 characters; the ceiling
    // below covers the largest a 2048-character source URL can produce.
    routerOptions: { maxParamLength: 4096 },
    // Fastify's own per-request lines are off: they carry the URL, and a source link in a
    // path or query must stay out of the log; the onResponse hook below logs the route
    // instead. The top-level `disableRequestLogging` that used to do this is deprecated
    // in favour of a controller.
    logController: new LogController({ disableRequestLogging: true }),
    // Long downloads must not be cut off by the server's own idle timer.
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
    // Keyed by the hashed client id rather than the raw address.
    keyGenerator: (request) => request.clientKey,
    // The server's own canary checks every source once a day and must not be throttled by
    // the limits it shares an address with.
    allowList: (request) => request.canary,
    addHeaders: { 'retry-after': true, 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('x-frame-options', 'DENY');
    // Set unconditionally: browsers ignore it on plain HTTP, and the header is what
    // protects a deployment that exposes the API on its own hostname.
    void reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
    // The API returns JSON and files; nothing it serves should ever execute.
    if (!reply.getHeader('content-security-policy')) {
      void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
    done(null, payload);
  });

  // Request logging is done here rather than by Fastify's default so the URL and the
  // client address never reach the log line.
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
  // Mounted only when a node token is configured; a deployment with no node should not
  // have an endpoint that accepts one.
  registerExtractionNodeRoutes(app, engine);
  // Likewise only with an admin token: usage counts for the operator.
  registerAdminRoutes(app, engine);

  return app;
}
