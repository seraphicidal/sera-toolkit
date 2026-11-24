import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('Website Legal Pages Content & Compliance', () => {
  const noticePath = fileURLToPath(
    new URL('../apps/web/src/app/legal/notice/page.tsx', import.meta.url),
  );
  const privacyPath = fileURLToPath(
    new URL('../apps/web/src/app/legal/privacy/page.tsx', import.meta.url),
  );
  const termsPath = fileURLToPath(
    new URL('../apps/web/src/app/legal/terms/page.tsx', import.meta.url),
  );
  const reportPath = fileURLToPath(
    new URL('../apps/web/src/app/legal/report/page.tsx', import.meta.url),
  );
  const reportFormPath = fileURLToPath(
    new URL('../apps/web/src/components/legal-report-form.tsx', import.meta.url),
  );
  const aboutPath = fileURLToPath(new URL('../apps/web/src/app/about/page.tsx', import.meta.url));
  const layoutPath = fileURLToPath(new URL('../apps/web/src/app/layout.tsx', import.meta.url));
  const cssPath = fileURLToPath(new URL('../apps/web/src/styles/globals.css', import.meta.url));
  const errorBoundaryPath = fileURLToPath(
    new URL('../apps/web/src/app/error.tsx', import.meta.url),
  );
  const notFoundPath = fileURLToPath(new URL('../apps/web/src/app/not-found.tsx', import.meta.url));
  const downloaderPath = fileURLToPath(
    new URL('../apps/web/src/components/downloader.tsx', import.meta.url),
  );
  const importClientPath = fileURLToPath(
    new URL('../apps/web/src/components/import-client.tsx', import.meta.url),
  );
  const apiRoutePath = fileURLToPath(
    new URL('../apps/web/src/app/api/[...path]/route.ts', import.meta.url),
  );

  it('verifies Provider Identification (DDG § 5 / E-Commerce Art. 5 / DSA Arts. 11 & 12)', () => {
    const content = readFileSync(noticePath, 'utf8');
    expect(content).toContain('DDG');
    expect(content).toContain('E-Commerce');
    expect(content).toContain('Digital Services Act');
    expect(content).toContain('OPERATOR_NAME');
    expect(content).toContain('OPERATOR_ADDRESS');
    expect(content).toContain('OPERATOR_EMAIL');
    expect(content).toContain('OPERATOR_REGISTRATION_ID');
    expect(content).toContain('CONTACT_EMAIL_AUTHORITIES');
    expect(content).toContain('CONTACT_EMAIL_LEGAL');
    expect(content).toContain('English and German');
    expect(content).toContain('cleanEmail');
  });

  it('verifies GDPR Privacy Notice requirements (Arts. 12-14 & ePrivacy)', () => {
    const content = readFileSync(privacyPath, 'utf8');
    expect(content).toContain('GDPR');
    expect(content).toContain('6(1)(f)');
    expect(content).toContain('1800');
    expect(content).toContain('30 minutes');
    expect(content).toContain('loadServiceInfo');
    expect(content).toContain('scope="col"');
    expect(content).toContain('thumbnail');
    expect(content).toContain('/api/thumb/:token');
    expect(content).toContain('sera-theme');
    expect(content).toContain('sera-preferred-kind');
    expect(content).toContain('sera-history');
    expect(content).toContain('Art. 15');
    expect(content).toContain('Art. 17');
    expect(content).toContain('Art. 77');
  });

  it('verifies Terms of Service & Acceptable Use (DSA Art. 14 & DMCA)', () => {
    const content = readFileSync(termsPath, 'utf8');
    expect(content).toContain('DSA');
    expect(content).toContain('Article 14');
    expect(content).toContain('warrant');
    expect(content).toContain('copyright');
    expect(content).toContain('malware');
    expect(content).toContain('/legal/report');
  });

  it('verifies Notice-and-Action Takedown Form (DSA Art. 16 & DMCA 512)', () => {
    const pageContent = readFileSync(reportPath, 'utf8');
    expect(pageContent).toContain('force-dynamic');
    expect(pageContent).toContain('LegalReportForm');
    const content = `${pageContent}\n${readFileSync(reportFormPath, 'utf8')}`;
    expect(content).toContain('/api/legal/report');
    expect(content).toContain('targetUrl');
    expect(content).toContain('category');
    expect(content).toContain('explanation');
    expect(content).toContain('notifierName');
    expect(content).toContain('notifierEmail');
    expect(content).toContain('goodFaithConfirmed');
    expect(content).toContain('minLength={10}');
    expect(content).toContain('minLength={2}');
  });

  it('verifies About page includes Storage Transparency, ClearHistoryButton, and Node Availability', () => {
    const content = readFileSync(aboutPath, 'utf8');
    expect(content).toContain('Local storage & ePrivacy');
    expect(content).toContain('sera-theme');
    expect(content).toContain('sera-preferred-kind');
    expect(content).toContain('sera-history');
    expect(content).toContain('ClearHistoryButton');
    expect(content).toContain('Per-Node Isolation');
    expect(content).toContain('6 releases');
    expect(content).toContain('7,071 lines changed');
    expect(content).toContain('nodeAvailability');
  });

  it('verifies Global Navigation footer includes all mandatory legal routes and validated nonce', () => {
    const content = readFileSync(layoutPath, 'utf8');
    expect(content).toContain('/legal/terms');
    expect(content).toContain('/legal/privacy');
    expect(content).toContain('/legal/notice');
    expect(content).toContain('/legal/report');
    expect(content).toContain('NONCE_PATTERN');
    expect(content).not.toContain('text-[var(--color-ink-faint)]/70');
  });

  it('verifies Accessibility (EAA 2025 / WCAG 2.1 AA) styling tokens and error boundaries', () => {
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toContain('--shadow-focus');
    expect(css).toContain('--color-canvas');
    expect(css).toContain('--color-surface');
    expect(css).toContain('--color-ink');
    expect(css).toContain('--color-ink-muted');
    expect(css).toContain('forced-colors: active');
    expect(existsSync(errorBoundaryPath)).toBe(true);
    expect(existsSync(notFoundPath)).toBe(true);
  });

  it('verifies web hardening regressions (API route allowlist, mobile trim inputMode, no dead postMessage)', () => {
    const route = readFileSync(apiRoutePath, 'utf8');
    expect(route).toContain('resolveSafeApiPath');
    expect(route).not.toContain('export const PUT');
    expect(route).not.toContain('export const PATCH');

    const downloader = readFileSync(downloaderPath, 'utf8');
    expect(downloader).toContain('inputMode="text"');
    expect(downloader).not.toContain('inputMode="numeric"');
    expect(downloader).toContain('getServiceInfo');
    expect(downloader).toContain('nodeAvailability');

    const importClient = readFileSync(importClientPath, 'utf8');
    expect(importClient).not.toContain('openImportChannel');
    expect(importClient).not.toContain('window.opener');
  });
});
