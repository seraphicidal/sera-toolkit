import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { legalReportRequestSchema } from '@sera/contracts';
import type { LegalReportResponse } from '@sera/contracts/types';
import type { SeraEngine } from '@sera/engine';

export function registerLegalRoutes(app: FastifyInstance, engine: SeraEngine): void {
  app.post(
    '/api/legal/report',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const parsed = legalReportRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_URL',
            message: 'Invalid report payload.',
            hint: parsed.error.issues[0]?.message,
            retryable: false,
          },
        });
      }

      const report = parsed.data;
      const reportId = `rep_${Date.now()}_${randomBytes(4).toString('hex')}`;
      const receivedAt = new Date().toISOString();

      let mitigated = false;
      if (report.category === 'malware') {
        try {
          const target = new URL(report.targetUrl);
          engine.denylist.blockHost(target.hostname, `Malware report ${reportId}`);
          mitigated = true;
        } catch {
          engine.denylist.blockUrl(report.targetUrl, `Malware report ${reportId}`);
          mitigated = true;
        }
      } else if (report.category === 'copyright' || report.category === 'illegal_content') {
        engine.denylist.blockUrl(report.targetUrl, `${report.category} report ${reportId}`);
        mitigated = true;
      }

      if (engine.config.dataDir) {
        const reportDir = join(engine.config.dataDir, 'reports');
        try {
          await mkdir(reportDir, { recursive: true });
          const filePath = join(reportDir, `${reportId}.json`);
          await writeFile(
            filePath,
            JSON.stringify(
              {
                reportId,
                receivedAt,
                ...report,
                mitigated,
                clientIp: request.ip,
              },
              null,
              2,
            ),
            'utf-8',
          );
        } catch (err) {
          engine.logger.error({ err, reportId }, 'failed to persist legal report');
        }
      }

      engine.logger.info(
        {
          reportId,
          category: report.category,
          targetUrl: report.targetUrl,
          mitigated,
        },
        'legal takedown notice received',
      );

      const response: LegalReportResponse = {
        reportId,
        receivedAt,
        status: mitigated ? 'action_taken' : 'received',
        mitigated,
      };

      return reply.status(201).send(response);
    },
  );
}
