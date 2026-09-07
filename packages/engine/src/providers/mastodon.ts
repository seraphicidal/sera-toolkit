import { SeraError } from '../errors.js';
import { ensureRecommendations } from '../normalize/plans.js';
import { hostMatchesAny, urlExtension } from '../security/url.js';
import { nonEmpty, truncate } from '../util/format.js';
import { normalizeContainer } from './direct.js';
import type { DownloadPlan, ProviderContext, ResolvedItem, ResolvedMedia } from './types.js';
import { YtdlpProvider } from './ytdlp-base.js';

/**
 * Mastodon and other fediverse servers.
 *
 * The fediverse has no canonical host list — anyone can run an instance — so detection
 * is by URL shape plus the largest well-known servers. `/@user/<numeric id>` and
 * `/users/<name>/statuses/<id>` are the two status forms every Mastodon-compatible
 * server serves, and matching on them keeps the provider from claiming unrelated sites.
 *
 * Video goes through yt-dlp. Everything else goes through the instance's own API: a
 * status routinely carries four images, and neither the extractor nor the page's single
 * `og:image` will give you more than one of them. `/api/v1/statuses/:id` is public for
 * public posts, needs no application registration, and returns every attachment at full
 * size with its alt text.
 */
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

  /** `/@name/123456` or `/users/name/statuses/123456`. */
  private static readonly STATUS_PATH = /^\/(@[^/]+\/\d+|users\/[^/]+\/statuses\/\d+)\/?$/;

  override canHandle(url: URL, host: string): boolean {
    if (hostMatchesAny(host, this.hosts)) return true;
    // An unknown host is claimed only when the path is unmistakably a fediverse status.
    return MastodonProvider.STATUS_PATH.test(url.pathname);
  }

  protected override wantsPlaylist(): boolean {
    return true;
  }

  override async resolve(url: URL, context: ProviderContext): Promise<ResolvedMedia> {
    // The API is tried first because it is the only path that sees every attachment.
    // yt-dlp still owns video, which it renders in several qualities the API cannot.
    const viaApi = await this.resolveViaApi(url, context).catch(() => undefined);
    if (viaApi?.items.every((item) => item.kind === 'image')) return viaApi;

    try {
      return await super.resolve(url, context);
    } catch (error) {
      if (viaApi) return viaApi;
      throw SeraError.from(error);
    }
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

/** `gifv` is Mastodon's name for a silent looping video, not an actual GIF file. */
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

  // A looping video is worth offering as a real GIF, and anything with a soundtrack is
  // worth offering as audio. Neither makes sense for a photograph.
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

/** The account's handle in its usual written form, or nothing if the server sent none. */
function atHandle(acct: string | undefined): string | undefined {
  const handle = nonEmpty(acct);
  if (!handle) return undefined;
  return `@${handle}`;
}

/** Alt text, when the poster wrote any. */
function describe(value: string | undefined): string | undefined {
  const text = nonEmpty(value);
  return text ? truncate(text, 120) : undefined;
}

/** Mastodon status content is HTML; only the readable text is wanted for a title. */
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
