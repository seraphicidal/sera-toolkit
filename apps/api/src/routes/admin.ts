import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SeraEngine } from '@sera/engine';
import { totalUsage, USAGE_RETENTION_DAYS } from '@sera/engine';
import { matchesToken } from '../plugins/client.js';

const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(USAGE_RETENTION_DAYS).default(7),
});

export function registerAdminRoutes(app: FastifyInstance, engine: SeraEngine): void {
  const { config } = engine;
  if (!config.adminToken) return;

  app.get(
    '/api/admin/usage',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!matchesToken(presented, config.adminToken)) {
        return reply.status(401).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
      }

      const { days } = usageQuerySchema.parse(request.query);
      const usage = await engine.usage.read(days);
      return reply
        .header('cache-control', 'no-store')
        .send({ days: usage, totals: totalUsage(usage) });
    },
  );
}
