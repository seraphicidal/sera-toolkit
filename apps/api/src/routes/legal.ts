import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { legalReportRequestSchema } from '@sera/contracts';
import type { LegalReportResponse } from '@sera/contracts/types';
import type { SeraEngine } from '@sera/engine';
import { checkAdminAuth } from '../plugins/admin-auth.js';
import { computeClientKey, normalizeClientAddress } from '../plugins/client.js';

const MAX_STORED_REPORTS = 5000;

export function registerLegalRoutes(app: FastifyInstance, engine: SeraEngine): void {
  let trackedReports: string[] | undefined;
  let reportPersistQueue: Promise<void> = Promise.resolve();

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
            code: 'VALIDATION_ERROR',
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
      const isAdmin = checkAdminAuth(request.headers.authorization, engine.config.adminToken);
      if (isAdmin) {
        if (report.category === 'malware') {
          try {
            const target = new URL(report.targetUrl);
            const entry = engine.denylist.blockHost(target.hostname, `Malware report ${reportId}`);
            mitigated = Boolean(entry);
          } catch {
            const entry = engine.denylist.blockUrl(report.targetUrl, `Malware report ${reportId}`);
            mitigated = Boolean(entry);
          }
        } else if (report.category === 'copyright' || report.category === 'illegal_content') {
          const entry = engine.denylist.blockUrl(
            report.targetUrl,
            `${report.category} report ${reportId}`,
          );
          mitigated = Boolean(entry);
        }
      }

      if (engine.config.dataDir) {
        const reportDir = join(engine.config.dataDir, 'reports');
        const persist = async (): Promise<void> => {
          await mkdir(reportDir, { recursive: true });
          if (trackedReports === undefined) {
            const existing = await readdir(reportDir).catch(() => [] as string[]);
            trackedReports = existing
              .filter((f) => f.endsWith('.json'))
              .sort((a, b) => reportTimestamp(a) - reportTimestamp(b) || a.localeCompare(b));
          }
          if (trackedReports.length >= MAX_STORED_REPORTS) {
            const current = await readdir(reportDir).catch(() => [] as string[]);
            trackedReports = current
              .filter((f) => f.endsWith('.json'))
              .sort((a, b) => reportTimestamp(a) - reportTimestamp(b) || a.localeCompare(b));
            if (trackedReports.length >= MAX_STORED_REPORTS) {
              const stale = trackedReports.splice(
                0,
                Math.max(1, trackedReports.length - MAX_STORED_REPORTS + 1),
              );
              await Promise.all(
                stale.map((f) => rm(join(reportDir, f), { force: true }).catch(() => undefined)),
              );
            }
          }
          const filename = `${reportId}.json`;
          const filePath = join(reportDir, filename);
          await writeFile(
            filePath,
            JSON.stringify(
              {
                reportId,
                receivedAt,
                ...report,
                mitigated,
                clientIp: computeClientKey(
                  normalizeClientAddress(request.ip),
                  engine.config.secret,
                ),
              },
              null,
              2,
            ),
            'utf-8',
          );
          trackedReports.push(filename);
        };
        const nextPersist = reportPersistQueue.then(persist, persist);
        reportPersistQueue = nextPersist.catch(() => undefined);
        try {
          await nextPersist;
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

      const topic =
        (engine.config.alertNtfyTopic.length > 0
          ? engine.config.alertNtfyTopic
          : process.env.SERA_ALERT_NTFY_TOPIC) ?? '';
      if (topic.length > 0) {
        const domain =
          (engine.config.domain.length > 0 ? engine.config.domain : process.env.SERA_DOMAIN) ?? '';
        const body = [
          `Category: ${report.category}`,
          `Report ID: ${reportId}`,
          `Action: ${mitigated ? 'Mitigated (denylisted)' : 'Pending Review'}`,
        ].join('\n');

        const headers: Record<string, string> = {
          Title: `SERA: Legal Report (${report.category})`,
          Priority: 'high',
          Tags: 'warning,scales',
        };
        if (domain) {
          headers.Click = `https://${domain}/legal/report`;
        }

        void fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(5_000),
        })
          .then((res) => {
            if (!res.ok) {
              engine.logger.warn(
                { status: res.status, reportId },
                'ntfy legal report notification rejected',
              );
            }
          })
          .catch((err: unknown) => {
            engine.logger.warn({ err, reportId }, 'failed to send ntfy legal report notification');
          });
      }

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

function reportTimestamp(filename: string): number {
  const match = /^rep_(\d+)_/.exec(filename);
  return match ? Number(match[1]) : 0;
}
