import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
  const aboutPath = fileURLToPath(new URL('../apps/web/src/app/about/page.tsx', import.meta.url));
  const layoutPath = fileURLToPath(new URL('../apps/web/src/app/layout.tsx', import.meta.url));
  const cssPath = fileURLToPath(new URL('../apps/web/src/styles/globals.css', import.meta.url));

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
  });

  it('verifies GDPR Privacy Notice requirements (Arts. 12-14 & ePrivacy)', () => {
    const content = readFileSync(privacyPath, 'utf8');
    expect(content).toContain('GDPR');
    expect(content).toContain('6(1)(f)');
    expect(content).toContain('1800');
    expect(content).toContain('30 minutes');
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
    const content = readFileSync(reportPath, 'utf8');
    expect(content).toContain('/api/legal/report');
    expect(content).toContain('targetUrl');
    expect(content).toContain('category');
    expect(content).toContain('explanation');
    expect(content).toContain('notifierName');
    expect(content).toContain('notifierEmail');
    expect(content).toContain('goodFaithConfirmed');
  });

  it('verifies About page includes Storage Transparency and ClearHistoryButton', () => {
    const content = readFileSync(aboutPath, 'utf8');
    expect(content).toContain('Local storage & ePrivacy');
    expect(content).toContain('sera-theme');
    expect(content).toContain('sera-preferred-kind');
    expect(content).toContain('sera-history');
    expect(content).toContain('ClearHistoryButton');
    expect(content).toContain('Per-Node Isolation');
    expect(content).toContain('6 releases');
    expect(content).toContain('7,071 lines changed');
  });

  it('verifies Global Navigation footer includes all mandatory legal routes', () => {
    const content = readFileSync(layoutPath, 'utf8');
    expect(content).toContain('/legal/terms');
    expect(content).toContain('/legal/privacy');
    expect(content).toContain('/legal/notice');
    expect(content).toContain('/legal/report');
  });

  it('verifies Accessibility (EAA 2025 / WCAG 2.1 AA) styling tokens', () => {
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toContain('--shadow-focus');
    expect(css).toContain('--color-canvas');
    expect(css).toContain('--color-surface');
    expect(css).toContain('--color-ink');
    expect(css).toContain('--color-ink-muted');
  });
});
