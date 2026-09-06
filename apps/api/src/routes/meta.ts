import type { FastifyInstance } from 'fastify';
import type { SeraEngine } from '@sera/engine';

export function registerMetaRoutes(app: FastifyInstance, engine: SeraEngine): void {
  /** What this deployment supports and what its limits are. Drives the About page. */
  app.get('/api/info', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=60').send(engine.serviceInfo()),
  );

  /**
   * Liveness.
   *
   * Reports 200 whenever the process is running, even when a tool check fails, because
   * an orchestrator should not restart a container over a temporarily unhappy extractor.
   * The body carries the detail; `/ready` is what gates traffic.
   */
  app.get('/health', async (_request, reply) => {
    const report = await engine.health();
    return reply.header('cache-control', 'no-store').send(report);
  });

  /**
   * Readiness.
   *
   * Fails when the binaries the pipeline depends on are missing, so a rolling deploy
   * with a broken image never receives traffic.
   */
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
