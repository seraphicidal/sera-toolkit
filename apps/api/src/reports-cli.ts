interface StoredReport {
  reportId?: string;
  receivedAt?: string;
  category?: string;
  mitigated?: boolean;
  targetUrl?: string;
  notifierName?: string;
  notifierEmail?: string;
  notifierOrganization?: string;
  clientIp?: string;
  explanation?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) =>
    args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

  const token = process.env.SERA_ADMIN_TOKEN ?? '';
  if (!token) {
    console.error('[reports] SERA_ADMIN_TOKEN is not set; see deploy/ORACLE.md');
    process.exitCode = 2;
    return;
  }

  const api = (value('--api') ?? `http://127.0.0.1:${process.env.SERA_PORT ?? '4000'}`).replace(
    /\/+$/,
    '',
  );
  const id = value('--id') ?? args.find((a) => !a.startsWith('-'));
  const jsonOutput = args.includes('--json');

  if (id) {
    const response = await fetch(`${api}/api/admin/reports/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      console.error(`[reports] report "${id}" not found`);
      process.exitCode = 1;
      return;
    }
    if (!response.ok) {
      console.error(`[reports] the API answered ${String(response.status)}`);
      process.exitCode = 1;
      return;
    }
    const report = (await response.json()) as StoredReport;
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const lines = [
      `Report ID:      ${report.reportId ?? id}`,
      `Received At:    ${report.receivedAt ?? 'unknown'}`,
      `Category:       ${report.category ?? 'unknown'}`,
      `Status:         ${report.mitigated ? 'Mitigated (action_taken)' : 'Pending Review'}`,
      `Target URL:     ${report.targetUrl ?? 'none'}`,
      `Notifier Name:  ${report.notifierName ?? 'anonymous'}`,
      `Notifier Email: ${report.notifierEmail ?? 'none'}`,
      `Organization:   ${report.notifierOrganization ?? 'none'}`,
      `Client IP:      ${report.clientIp ?? 'unknown'}`,
      '',
      'Explanation:',
      report.explanation ?? '',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  const limit = value('--limit') ?? '50';
  const response = await fetch(`${api}/api/admin/reports?limit=${encodeURIComponent(limit)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    console.error(`[reports] the API answered ${String(response.status)}`);
    process.exitCode = 1;
    return;
  }
  const body = (await response.json()) as {
    reports: StoredReport[];
    total: number;
  };
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  if (body.total === 0 || body.reports.length === 0) {
    process.stdout.write('No legal reports found.\n');
    return;
  }
  const output: string[] = [`Legal Reports (Total: ${String(body.total)}):`, ''];
  for (const rep of body.reports) {
    const repId = rep.reportId ?? '';
    const date = rep.receivedAt ?? '';
    const cat = rep.category ?? '';
    const status = rep.mitigated ? '[mitigated]' : '[pending]';
    const target = rep.targetUrl ?? '';
    const name = rep.notifierName ?? '';
    const email = rep.notifierEmail ?? '';
    const org = rep.notifierOrganization ? ` (${rep.notifierOrganization})` : '';
    output.push(`${repId}  ${date}  [${cat}] ${status}`);
    output.push(`  Target:   ${target}`);
    output.push(`  Notifier: ${name} <${email}>${org}`);
    output.push('');
  }
  output.push('Use "sera reports <id>" to view full details.');
  process.stdout.write(`${output.join('\n')}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
