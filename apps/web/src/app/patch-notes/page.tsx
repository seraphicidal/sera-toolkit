import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@/components/wordmark';

export const metadata: Metadata = {
  title: 'Patch Notes',
  description:
    'Full changelog, security audit history, bug fixes, and line counter across SERA.toolkit.',
};

export const revalidate = 60;

interface PatchRecord {
  readonly version: string;
  readonly title: string;
  readonly date: string;
  readonly stats: {
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
    readonly total: number;
  };
  readonly highlights: readonly string[];
  readonly categories: readonly {
    readonly name: string;
    readonly items: readonly string[];
  }[];
}

const PATCHES: readonly PatchRecord[] = [
  {
    version: 'Update 1.1',
    title: 'Download Acceleration, Connection Pipelining & Quick Actions',
    date: 'October 13, 2026',
    stats: {
      files: 10,
      insertions: 265,
      deletions: 55,
      total: 320,
    },
    highlights: [
      'Multi-fragment concurrent stream acceleration in yt-dlp with expanded 64KB extraction buffers.',
      'Auto-threaded FFmpeg media transcoding across all available hardware cores.',
      'Reduced filesystem context switching and syscall overhead with 512KB write stream buffers.',
      'HTTP keep-alive connection reuse and pipelining enabled on safe internal dispatchers.',
      'Mobile one-tap Paste & Analyze, Cmd/Ctrl + Enter download shortcut, and format kind persistence.',
      'One-click download link copying with instant feedback, per-file copy links, and native in-browser media previews.',
    ],
    categories: [
      {
        name: 'Download & Conversion Acceleration',
        items: [
          'Added --concurrent-fragments 4 and --buffer-size 64K to yt-dlp to accelerate DASH and HLS video fragment extraction.',
          'Enabled automatic multi-threading (-threads 0) in FFmpeg across audio/video conversions and remuxing.',
          'Increased direct download write stream highWaterMark buffer from 64KB to 512KB to cut disk I/O overhead.',
          'Configured connection pipelining and persistent keep-alive timeouts (30s / 60s) in Undici safe dispatchers.',
        ],
      },
      {
        name: 'Convenience & Quick Actions',
        items: [
          'Exposed Paste button on mobile screens with automatic one-tap link analysis upon pasting.',
          'Added Cmd+Enter / Ctrl+Enter (and Enter key outside form inputs) keyboard shortcut to start download.',
          'Persisted user-preferred format kind in local storage across browser visits with private browsing error guards.',
          'Added Copy Download Link button with live copy status toasts on finished downloads.',
          'Integrated zero-dependency in-browser HTML5 preview player for audio, video, and image downloads.',
          'Added individual copy buttons for multi-file collections and carousels.',
        ],
      },
    ],
  },
  {
    version: 'Audit Pass 3',
    title: 'SSRF, Token Boundaries, ReDoS & System Security',
    date: 'October 13, 2026',
    stats: {
      files: 47,
      insertions: 878,
      deletions: 136,
      total: 1014,
    },
    highlights: [
      'Hardened IPv6 transition ranges (IPv4-compatible ::/96, SIIT ::ffff:0:0:0/96, local NAT64 64:ff9b:1::/48, Teredo 2001::/23, 6to4 2002::/16) and expanded IPv4-mapped address unwrapping.',
      'Eliminated cross-purpose token confusion across thumbnail, info, and option signed tokens.',
      'Replaced exponential regex robots.txt wildcard matching with a linear-time O(|pattern| + |path|) wildcard matcher.',
      'Enforced constant-time SHA-256 token verification, rightmost X-Forwarded-For hop inspection, and trailing-dot hostname canonicalization.',
      'Restricted FFmpeg and ffprobe protocol whitelists to local files and pipes, blocking HLS/concat container SSRF.',
    ],
    categories: [
      {
        name: 'Cybersecurity & Boundaries',
        items: [
          'Blocked IPv6 transition, SIIT, NAT64, 6to4, and Teredo ranges in isPublicAddress to prevent network perimeter bypasses.',
          'Normalized and stripped trailing dots in parseUserUrl and hostMatches to block FQDN trailing-dot SSRF and denylist evasions.',
          'Hardened verifyThumbnailToken, verifyInfoId, and verifyOptionId against cross-purpose token key reuse and foreign payload injection.',
          'Added SHA-256 pre-hashing to timingSafeEqual in bearer authentication to prevent token length timing side-channels.',
          'Extracted rightmost hop of X-Forwarded-For to prevent rate-limit and abuse-guard client IP spoofing behind reverse proxies.',
          'Enforced https: protocol requirement on all upstream media and manifest URLs across Twitter, Reddit, Mastodon, and Instagram.',
          'Added -protocol_whitelist file,pipe,data to all FFmpeg and ffprobe invocations to block container-level SSRF.',
          'Replaced backtracking regex in robots.txt parser with linear-time wildcard matching, eliminating ReDoS vulnerabilities.',
        ],
      },
      {
        name: 'Engine & Extraction Nodes',
        items: [
          'Bounded JSON recursion and stripped __proto__ in imported post schema preprocessing to prevent call-stack overflows and prototype pollution.',
          'Enforced per-task file counts and cumulative byte limits on internal extraction node uploads.',
          'Automatically cleaned up temporary upload directories when extraction node tasks fail, cancel, or lease-expire.',
          'Forwarded claimedBy node telemetry and added 30-second abort timeouts on internal HTTP dispatch.',
          'Gated Mastodon fallback strategy to approved hosts and translated unknown-host errors to unsupported source status.',
          'Used lstat in WorkspaceManager.resolveFile and zip packaging to reject symlink traversal attacks.',
        ],
      },
      {
        name: 'Web Client & User Experience',
        items: [
          'Guarded useJob startPolling with a boolean polling flag and cleared grace timers to prevent duplicate polling loops.',
          'Filtered available format tabs by currently selected carousel items, auto-switching format kind when items are toggled.',
          'Reset subtitles-only download flag when subtitle tracks are cleared via dropdown or trim adjustments.',
          'Added isSafeDownloadPath checks on result panel download links to enforce /api/ containment.',
          'Passed importMode flag to Downloader on /import to hide redundant URL forms and recent history.',
        ],
      },
    ],
  },
  {
    version: 'Audit Pass 2',
    title: 'Engine Architecture, Concurrency & Stream Safety',
    date: 'October 13, 2026',
    stats: {
      files: 34,
      insertions: 458,
      deletions: 170,
      total: 628,
    },
    highlights: [
      'Refactored memory queue with bounded concurrency and drain synchronization.',
      'Guarded child process execution with signal listeners and clean process group termination.',
      'Hardened stream pipelines against unhandled rejections during premature client disconnection.',
      'Prevented memory leaks in SSE event streams with heartbeat pings and auto-cleanup listeners.',
    ],
    categories: [
      {
        name: 'Streaming & Lifecycle',
        items: [
          'Added clientAbortSignal listeners across SSE job event routes to immediately abort worker streams on tab close.',
          'Wrapped child process spawns with tree-kill guarantees and timeout watchdogs.',
          'Guarded Redis and in-memory queue task execution against duplicated job pickup.',
          'Sanitized error output to strip system paths, environment details, and stack traces from client responses.',
        ],
      },
      {
        name: 'Media Pipeline',
        items: [
          'Hardened direct media downloads against content-length mismatches and incomplete byte streams.',
          'Sanitized filename generation to prevent directory traversal and illegal Windows/Linux characters.',
          'Enforced non-negative duration bounds and maximum item counts across multi-item playlists and carousels.',
        ],
      },
    ],
  },
  {
    version: 'Audit Pass 1',
    title: 'State Races, UX Resiliency & Accessibility',
    date: 'October 12, 2026',
    stats: {
      files: 21,
      insertions: 684,
      deletions: 157,
      total: 841,
    },
    highlights: [
      'Fixed stale job state reuse across consecutive downloads in useJob and Downloader.',
      'Corrected SpinnerIcon CSS class merging so loading spinners animate properly.',
      'Guarded localStorage access with try/catch to prevent SecurityError crashes in private browsing.',
      'Resolved global Escape key listener conflicts between popovers, inputs, and download cancellation.',
      'Added full keyboard navigation, ARIA live regions, and semantic roles across format and packaging controls.',
    ],
    categories: [
      {
        name: 'Component State & UX',
        items: [
          'Cleared previous job state when jobId becomes undefined or changes to prevent premature download triggers.',
          'Retained created job in Downloader state to prevent queued notice flicker before first SSE event.',
          'Disabled URL form clear button during active download jobs to avoid accidental state resets.',
          'Disallowed conflicting combinations of subtitles and video trimming while keeping validation errors visible.',
          'Cleaned pasted share text sentences to extract embedded URLs before submission.',
        ],
      },
      {
        name: 'Accessibility & Design',
        items: [
          'Added ArrowUp/ArrowDown/ArrowLeft/ArrowRight keyboard navigation for radiogroups.',
          'Configured ARIA live regions for error alerts and progress announcements.',
          'Ensured high contrast focus rings across interactive controls in both light and dark themes.',
        ],
      },
    ],
  },
];

export default function PatchNotesPage() {
  const totalInsertions = PATCHES.reduce((acc, p) => acc + p.stats.insertions, 0);
  const totalDeletions = PATCHES.reduce((acc, p) => acc + p.stats.deletions, 0);
  const totalLines = totalInsertions + totalDeletions;

  return (
    <article className="flex flex-col gap-10 pt-4 pb-16">
      <header>
        <h1 className="mb-2">
          <Wordmark size="lg" />
        </h1>
        <p className="text-[0.9375rem] text-balance text-[var(--color-ink-muted)]">
          Audit history, security hardening, bug fixes, and line counters for SERA.toolkit.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Lines Changed" value={totalLines.toLocaleString()} accent />
        <StatCard label="Audit Passes" value={String(PATCHES.length)} />
        <StatCard label="Code Insertions" value={`+${totalInsertions.toLocaleString()}`} />
        <StatCard label="Code Deletions" value={`−${totalDeletions.toLocaleString()}`} />
      </section>

      {PATCHES.map((patch) => (
        <section
          key={patch.version}
          className="flex flex-col gap-5 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-lift)] sm:p-6"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-line)] pb-4">
            <div>
              <span className="text-xs font-semibold tracking-wider text-[var(--color-accent)] uppercase">
                {patch.version}
              </span>
              <h2 className="text-lg font-medium text-[var(--color-ink)]">{patch.title}</h2>
            </div>
            <div className="text-right">
              <span className="text-xs text-[var(--color-ink-faint)]">{patch.date}</span>
              <p className="tabular text-xs font-medium text-[var(--color-ink-muted)]">
                {patch.stats.files} files · {patch.stats.total} lines (+{patch.stats.insertions} / −
                {patch.stats.deletions})
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
              Highlights
            </h3>
            <ul className="list-disc space-y-1.5 pl-5 text-[0.875rem] leading-relaxed text-[var(--color-ink)]">
              {patch.highlights.map((highlight, index) => (
                <li key={index}>{highlight}</li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-4 pt-2">
            {patch.categories.map((category) => (
              <div key={category.name} className="flex flex-col gap-1.5">
                <h4 className="text-xs font-medium text-[var(--color-ink-muted)]">
                  {category.name}
                </h4>
                <ul className="list-disc space-y-1 pl-5 text-[0.8125rem] leading-relaxed text-[var(--color-ink-muted)]">
                  {category.items.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-sunken)] p-5 text-[0.875rem] text-[var(--color-ink-muted)]">
        <h2 className="text-xs font-semibold tracking-wide text-[var(--color-ink-faint)] uppercase">
          Verification & Guarantee
        </h2>
        <p>
          Every release passes strict automated verification suites with zero runtime third-party
          dependencies, strict TypeScript adherence, and full regression testing across SSRF, ReDoS,
          and lifecycle bounds.
        </p>
      </section>

      <div className="flex items-center justify-between border-t border-[var(--color-line)] pt-6">
        <Link
          href="/"
          className="text-[0.9375rem] font-medium text-[var(--color-accent)] transition-opacity hover:opacity-75"
        >
          ← Back to the toolkit
        </Link>
        <Link
          href="/about"
          className="text-[0.9375rem] text-[var(--color-ink-muted)] transition-opacity hover:opacity-75"
        >
          About SERA →
        </Link>
      </div>
    </article>
  );
}

function StatCard({
  label,
  value,
  accent = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-panel)] border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5 shadow-sm">
      <span className="text-xs text-[var(--color-ink-faint)]">{label}</span>
      <span
        className={`tabular text-lg font-semibold ${
          accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
