import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SeraEngine } from '@sera/engine';
import { totalUsage, USAGE_RETENTION_DAYS } from '@sera/engine';
import { matchesToken } from '../plugins/client.js';

const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(USAGE_RETENTION_DAYS).default(7),
});

const reportsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const reportParamsSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
});

const denylistCreateSchema = z.object({
  type: z.enum(['host', 'url']),
  target: z.string().trim().min(1).max(2048),
  reason: z.string().trim().min(1).max(500).default('Administrative block'),
});

const denylistParamsSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
});

function checkAdminAuth(header: string | undefined, adminToken: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return matchesToken(presented, adminToken);
}

export function registerAdminRoutes(app: FastifyInstance, engine: SeraEngine): void {
  const { config } = engine;
  if (!config.adminToken) return;

  app.get(
    '/api/admin/usage',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!checkAdminAuth(request.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }

      const { days } = usageQuerySchema.parse(request.query);
      const usage = await engine.usage.read(days);
      return reply
        .header('cache-control', 'no-store')
        .send({ days: usage, totals: totalUsage(usage) });
    },
  );

  app.get(
    '/api/admin/reports',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!checkAdminAuth(request.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }

      const { limit, offset } = reportsQuerySchema.parse(request.query);
      if (!config.dataDir) {
        return reply.header('cache-control', 'no-store').send({ reports: [], total: 0 });
      }

      const reportDir = join(config.dataDir, 'reports');
      let files: string[];
      try {
        files = await readdir(reportDir);
      } catch {
        return reply.header('cache-control', 'no-store').send({ reports: [], total: 0 });
      }

      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      const records = (
        await Promise.all(
          jsonFiles.map(async (file) => {
            try {
              const content = await readFile(join(reportDir, file), 'utf-8');
              return JSON.parse(content) as Record<string, unknown>;
            } catch {
              return null;
            }
          }),
        )
      ).filter((r): r is Record<string, unknown> => r !== null);

      records.sort((a, b) => {
        const timeA = typeof a.receivedAt === 'string' ? Date.parse(a.receivedAt) : 0;
        const timeB = typeof b.receivedAt === 'string' ? Date.parse(b.receivedAt) : 0;
        return timeB - timeA;
      });

      const total = records.length;
      const paginated = records.slice(offset, offset + limit);

      return reply.header('cache-control', 'no-store').send({ reports: paginated, total });
    },
  );

  app.get(
    '/api/admin/reports/:id',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!checkAdminAuth(request.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }

      const parsedParams = reportParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_PARAMS', message: 'Invalid report ID.' } });
      }

      if (!config.dataDir) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
      }

      const filePath = join(config.dataDir, 'reports', `${parsedParams.data.id}.json`);
      try {
        const content = await readFile(filePath, 'utf-8');
        return reply.header('cache-control', 'no-store').send(JSON.parse(content));
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Report not found.' } });
      }
    },
  );

  app.get(
    '/api/admin/denylist',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!checkAdminAuth(request.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }

      return reply
        .header('cache-control', 'no-store')
        .send({ entries: engine.denylist.listBlocked() });
    },
  );

  app.post(
    '/api/admin/denylist',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!checkAdminAuth(request.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }

      const parsedBody = denylistCreateSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_PARAMS', message: 'Invalid denylist payload.' } });
      }

      const { type, target, reason } = parsedBody.data;
      const entry =
        type === 'host'
          ? engine.denylist.blockHost(target, reason)
          : engine.denylist.blockUrl(target, reason);

      if (!entry) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_TARGET', message: 'Invalid denylist target.' } });
      }

      return reply.status(201).header('cache-control', 'no-store').send(entry);
    },
  );

  app.delete(
    '/api/admin/denylist/:id',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!checkAdminAuth(request.headers.authorization, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }

      const parsedParams = denylistParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply
          .status(400)
          .send({ error: { code: 'INVALID_PARAMS', message: 'Invalid denylist entry ID.' } });
      }

      const { id } = parsedParams.data;
      const removed = engine.denylist.unblock(id);
      if (!removed) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Denylist entry not found.' } });
      }

      return reply.status(200).header('cache-control', 'no-store').send({ deleted: true, id });
    },
  );
}
