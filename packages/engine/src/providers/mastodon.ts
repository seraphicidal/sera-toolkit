import type { ProviderCapabilities } from '@sera/contracts/types';
import { seraError } from '../errors.js';
import type { ExtractionStrategy } from '../extract/strategy.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { hostMatchesAny, urlExtension } from '../security/url.js';
import { nonEmpty, truncate } from '../util/format.js';
import { normalizeContainer } from './direct.js';
import type { DownloadPlan, ProviderContext, ResolvedItem, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';
import { declare } from './capabilities.js';

export class MastodonProvider extends YtdlpProvider {
  readonly id = 'mastodon';
  readonly label = 'Mastodon';
  readonly hosts = [
    'mastodon.social',
    'mastodon.online',
    'mastodon.world',
    'mstdn.social',
    'fosstodon.org',
    'hachyderm.io',
    'infosec.exchange',
    'techhub.social',
    'mas.to',
  ];
  override readonly priority = 40;

  override readonly capabilities: ProviderCapabilities = declare({
    image: true,
    carousel: true,
    gif: true,
    residentialFallback: false,
  });

  private static readonly STATUS_PATH = /^\/(@[^/]+\/\d+|users\/[^/]+\/statuses\/\d+)\/?$/;

  override canHandle(url: URL, host: string): boolean {
    if (hostMatchesAny(host, this.hosts)) return true;
    return MastodonProvider.STATUS_PATH.test(url.pathname);
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  protected override strategies(
    _url: URL,
    _context: ProviderContext,
  ): readonly ExtractionStrategy[] {
    return [
      {
        id: 'instance-api',
        label: "the instance's public API",
        run: async (target, ctx) => {
          const media = await this.resolveViaApi(target, ctx);
          if (!media?.items.length) {
            throw seraError('UNSUPPORTED_SOURCE', {
              detail: 'mastodon: the status carries no attachments this API can read',
            });
          }
          if (!media.items.every((item) => item.kind === 'image')) {
            throw seraError('UNSUPPORTED_SOURCE', {
              detail: 'mastodon: video, which the extractor renders in more qualities',
            });
          }
          return media;
        },
      },
      {
        id: 'ytdlp',
        label: 'the extractor',
        run: (target, ctx) => this.runExtractor(target, ctx),
      },
      {
        id: 'instance-api-anything',
        label: "the instance's public API, taking whatever it has",
        run: async (target, ctx) => {
          const media = await this.resolveViaApi(target, ctx);
          if (!media?.items.length) {
            throw seraError('MEDIA_UNAVAILABLE', { detail: 'mastodon: nothing in the status' });
          }
          return media;
        },
      },
    ];
  }

  private async resolveViaApi(
    url: URL,
    context: ProviderContext,
  ): Promise<ResolvedMedia | undefined> {
    const id = statusIdFrom(url);
    if (!id) return undefined;

    const endpoint = new URL(`/api/v1/statuses/${id}`, url.origin);
    const { body } = await context.fetchText(endpoint, 512 * 1024);
    const status = JSON.parse(body) as MastodonStatus;

    const attachments = (status.media_attachments ?? []).filter(
      (a) => typeof a?.url === 'string' && a.url.startsWith('https://'),
    );
    if (!attachments.length) return undefined;

    const author = nonEmpty(status.account?.display_name) ?? atHandle(status.account?.acct);
    const text = stripHtml(status.content ?? '');

    const items: ResolvedItem[] = attachments
      .slice(0, context.config.maxItemsPerJob)
      .map((attachment, index) => toItem(attachment, index));

    return {
      provider: this.id,
      providerLabel: this.label,
      url: url.toString(),
      type: items.length > 1 ? 'collection' : 'single',
      title: text ? truncate(text, 200) : `Post by ${author ?? 'a fediverse account'}`,
      ...(text ? { description: truncate(text, 500) } : {}),
      ...(author ? { author } : {}),
      ...(items[0]?.thumbnailUrl ? { thumbnailUrl: items[0].thumbnailUrl } : {}),
      items,
      metadata: { attachments: String(attachments.length) },
    };
  }
}

interface MastodonAttachment {
  readonly id?: string;
  readonly type?: string;
  readonly url: string;
  readonly preview_url?: string;
  readonly description?: string;
  readonly meta?: { readonly original?: { readonly width?: number; readonly height?: number } };
}

interface MastodonStatus {
  readonly content?: string;
  readonly account?: { readonly acct?: string; readonly display_name?: string };
  readonly media_attachments?: readonly MastodonAttachment[];
}

function statusIdFrom(url: URL): string | undefined {
  const match = /(?:^\/@[^/]+\/|^\/users\/[^/]+\/statuses\/)(\d+)\/?$/.exec(url.pathname);
  return match?.[1];
}

function kindFor(type: string | undefined): DownloadPlan['kind'] {
  if (type === 'video') return 'video';
  if (type === 'gifv') return 'gif';
  if (type === 'audio') return 'audio';
  return 'image';
}

function toItem(attachment: MastodonAttachment, index: number): ResolvedItem {
  const kind = kindFor(attachment.type);
  const extension = urlExtension(new URL(attachment.url)) ?? '';
  const container = normalizeContainer('', extension);
  const width = attachment.meta?.original?.width;
  const height = attachment.meta?.original?.height;

  const plans: DownloadPlan[] = [
    {
      kind,
      container,
      label: 'Original',
      detail: [container.toUpperCase(), width && height ? `${width} × ${height}` : undefined]
        .filter(Boolean)
        .join(' · '),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      requiresConversion: false,
      recommended: true,
      fetch: { via: 'direct', url: attachment.url },
    },
  ];

  if (kind === 'gif') {
    plans.push({
      kind: 'gif',
      container: 'gif',
      label: 'GIF',
      detail: 'Converted from the looping video',
      requiresConversion: true,
      recommended: false,
      fetch: { via: 'direct', url: attachment.url },
      convert: { kind: 'gif' },
    });
  }
  if (kind === 'video') {
    plans.push({
      kind: 'audio',
      container: 'mp3',
      label: 'MP3',
      detail: '320 kbps · extracted',
      audioBitrateKbps: 320,
      requiresConversion: true,
      recommended: false,
      fetch: { via: 'direct', url: attachment.url },
      convert: { kind: 'audio', container: 'mp3', bitrateKbps: 320 },
    });
  }

  return {
    sourceId: attachment.id ?? String(index),
    index,
    kind,
    title: describe(attachment.description) ?? `Attachment ${index + 1}`,
    ...(attachment.preview_url ? { thumbnailUrl: attachment.preview_url } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    container,
    plans: ensureRecommendations(plans),
  };
}

function atHandle(acct: string | undefined): string | undefined {
  const handle = nonEmpty(acct);
  if (!handle) return undefined;
  return `@${handle}`;
}

function describe(value: string | undefined): string | undefined {
  const text = nonEmpty(value);
  return text ? truncate(text, 120) : undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp|#\d+);/gi,
      (entity) => ENTITIES[entity.toLowerCase()] ?? ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};
