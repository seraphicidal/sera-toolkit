import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { SERA_VERSION } from '@sera/contracts/types';
import { ThemeToggle, themeScript } from '@/components/theme-toggle';
import { Wordmark } from '@/components/wordmark';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SERA.toolkit — universal media toolkit',
    template: '%s · SERA.toolkit',
  },
  description:
    'Paste a link and get the media. A universal downloader and converter for publicly accessible video, audio, images and GIFs.',
  applicationName: 'SERA.toolkit',
  robots: { index: true, follow: true },
  // No analytics, no third-party fonts, no external anything.
  other: { referrer: 'no-referrer' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfbfa' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0f12' },
  ],
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint so dark mode never flashes white. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only-focusable absolute top-3 left-3 z-50 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-accent-ink)]"
        >
          Skip to content
        </a>

        <div className="mx-auto flex min-h-dvh w-full max-w-[46rem] flex-col px-5 sm:px-6">
          <header className="flex items-center justify-between gap-4 py-5">
            <Link
              href="/"
              className="rounded-md transition-opacity hover:opacity-70"
              aria-label="SERA.toolkit home"
            >
              <Wordmark size="sm" />
            </Link>
            <div className="flex items-center gap-3">
              <Link
                href="/about"
                className="rounded-md text-sm text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
              >
                About
              </Link>
              <ThemeToggle />
            </div>
          </header>

          <main id="main" className="flex flex-1 flex-col">
            {children}
          </main>

          <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-[var(--color-line)] py-5 text-xs text-[var(--color-ink-faint)]">
            <p>You are responsible for having the rights to the media you download.</p>
            <div className="flex items-center gap-3">
              <Link
                href="/about"
                className="rounded-md transition-colors hover:text-[var(--color-ink-muted)]"
              >
                How this works
              </Link>
              {/* Unobtrusive, but present: knowing the build is what makes a bug report
                  actionable. */}
              <span className="tabular text-[var(--color-ink-faint)]/70">v{SERA_VERSION}</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
