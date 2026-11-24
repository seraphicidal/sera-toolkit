import { createHash } from 'node:crypto';
import { themeScript } from './theme-script';

export const themeScriptHash = createHash('sha256').update(themeScript).digest('base64');

export interface CspOptions {
  readonly nonce?: string;
  readonly isDev?: boolean;
  readonly forceHttps?: boolean;
}

export function buildCspHeader(options: CspOptions = {}): string {
  const { nonce, isDev = false, forceHttps = process.env.SERA_FORCE_HTTPS === 'true' } = options;

  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`
    : `script-src 'self' 'sha256-${themeScriptHash}'${isDev ? " 'unsafe-eval'" : ''}`;

  const styleDirectives = isDev
    ? ["style-src 'self' 'unsafe-inline'"]
    : ["style-src 'self'", "style-src-elem 'self'", "style-src-attr 'unsafe-inline'"];

  return [
    "default-src 'self'",
    scriptSrc,
    ...styleDirectives,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(forceHttps ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
