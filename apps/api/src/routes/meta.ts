import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HealthReport } from '@sera/contracts/types';
import type { SeraEngine } from '@sera/engine';
import { checkAdminAuth } from '../plugins/admin-auth.js';
import { normalizeClientAddress } from '../plugins/client.js';

function isLoopback(address: string): boolean {
  let bare = address.trim();
  if (bare.startsWith('[') && bare.endsWith(']')) {
    bare = bare.slice(1, -1);
  }
  const zoneIndex = bare.indexOf('%');
  if (zoneIndex !== -1) {
    bare = bare.slice(0, zoneIndex);
  }
  if (
    bare === 'localhost' ||
    bare === '::1' ||
    /^(?:0{1,4}:){7}0{0,3}1$/i.test(bare) ||
    /^(?:0{1,4}:){1,6}:0{0,3}1$/i.test(bare)
  ) {
    return true;
  }
  return normalizeClientAddress(bare) === '127.0.0.1';
}

function isAuthorized(request: FastifyRequest, engine: SeraEngine): boolean {
  return request.canary || checkAdminAuth(request.headers.authorization, engine.config.adminToken);
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
          request.canary ||
          (!request.headers['x-forwarded-for'] &&
            !request.headers.forwarded &&
            !request.headers['x-real-ip'] &&
            !request.headers['cf-connecting-ip'] &&
            !request.headers['true-client-ip'] &&
            !request.headers['x-forwarded-host'] &&
            !request.headers['x-forwarded-proto'] &&
            !request.headers.via &&
            isLoopback(request.ip)),
      },
    },
  };

  app.get('/api/info', metaRateLimit, async (_request, reply) =>
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
      (check) =>
        check.name === 'yt-dlp' ||
        check.name === 'ffmpeg' ||
        check.name === 'storage' ||
        check.name === 'queue',
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
