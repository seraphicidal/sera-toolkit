import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HealthReport } from '@sera/contracts/types';
import type { SeraEngine } from '@sera/engine';
import { matchesToken } from '../plugins/client.js';

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === 'localhost'
  );
}

function isAuthorized(request: FastifyRequest, engine: SeraEngine): boolean {
  if (request.canary) return true;
  const { adminToken } = engine.config;
  if (!adminToken) return false;
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  return matchesToken(presented, adminToken);
}

function redactHealthReport(report: HealthReport): HealthReport {
  return {
    status: report.status,
    version: report.version,
    uptimeSeconds: report.uptimeSeconds,
    checks: report.checks.map((check) => ({
      name: check.name,
      status: check.status,
    })),
  };
}

export function registerMetaRoutes(app: FastifyInstance, engine: SeraEngine): void {
  const metaRateLimit = {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
        allowList: (request: FastifyRequest) =>
          request.canary || (!request.headers['x-forwarded-for'] && isLoopback(request.ip)),
      },
    },
  };

  app.get('/api/info', async (_request, reply) =>
    reply.header('cache-control', 'public, max-age=60').send(engine.serviceInfo()),
  );

  app.get('/health', metaRateLimit, async (request, reply) => {
    const report = await engine.health();
    const payload = isAuthorized(request, engine) ? report : redactHealthReport(report);
    return reply.header('cache-control', 'no-store').send(payload);
  });

  app.get('/ready', metaRateLimit, async (request, reply) => {
    const report = await engine.health();
    const essential = report.checks.filter(
      (check) => check.name === 'yt-dlp' || check.name === 'ffmpeg',
    );
    const ready = essential.every((check) => check.status === 'ok');
    const checks = isAuthorized(request, engine)
      ? report.checks
      : redactHealthReport(report).checks;
    return reply
      .status(ready ? 200 : 503)
      .header('cache-control', 'no-store')
      .send({ ready, checks });
  });
}
