import type { FastifyInstance } from 'fastify';
import type { SeraEngine } from '@sera/engine';

export function registerMetaRoutes(app: FastifyInstance, engine: SeraEngine): void {
  app.get('/api/info', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=60').send(engine.serviceInfo()),
  );

  app.get('/health', async (_request, reply) => {
    const report = await engine.health();
    return reply.header('cache-control', 'no-store').send(report);
  });

  app.get('/ready', async (_request, reply) => {
    const report = await engine.health();
    const essential = report.checks.filter(
      (check) => check.name === 'yt-dlp' || check.name === 'ffmpeg',
    );
    const ready = essential.every((check) => check.status === 'ok');
    return reply
      .status(ready ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({ ready, checks: report.checks });
  });
}
