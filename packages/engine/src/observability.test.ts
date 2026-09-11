import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import type { YtdlpInfo } from './extract/ytdlp-types.js';
import { logSafeUrl, REDACTED_PATHS, REDACTION_CENSOR, type Logger } from './logging.js';
import { MediaResolver } from './resolver.js';

/**
 * What a log line has to say, and what it must never say.
 *
 * A media downloader's logs are a record of what people watched unless someone decides
 * otherwise, so the redaction list is the privacy policy in code and this is the test
 * that keeps it honest. The positive half matters for a different reason: these fields
 * are the ones an operator correlates when a provider starts failing, and a field that
 * quietly stops being emitted is not something anybody notices until they need it.
 */
function capture(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const written: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });
  return {
    // The real redaction configuration, not a restatement of it.
    logger: pino(
      { level: 'info', redact: { paths: [...REDACTED_PATHS], censor: REDACTION_CENSOR } },
      sink,
    ),
    lines: () =>
      written
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const info: YtdlpInfo = {
  id: 'x',
  _type: 'video',
  title: 'A Video Title',
  webpage_url: 'https://www.youtube.com/watch?v=x',
  duration: 30,
  formats: [
    {
      format_id: '18',
      ext: 'mp4',
      protocol: 'https',
      vcodec: 'avc1.42001E',
      acodec: 'mp4a.40.2',
      height: 360,
      width: 640,
      url: 'https://rr1---sn-secret.googlevideo.com/videoplayback?sig=SECRETSIGNATURE',
    },
  ],
};

function resolverWith(logger: Logger, env: Record<string, string> = {}): MediaResolver {
  return new MediaResolver({
    config: loadConfig({
      NODE_ENV: 'test',
      SERA_SECRET: 'observability-secret',
      SERA_DATA_DIR: '.data/test',
      ...env,
    }),
    logger,
    probe: () => Promise.resolve(info),
  });
}

describe('the line a resolve writes', () => {
  it('carries what an operator correlates on', async () => {
    const { logger, lines } = capture();
    const resolver = resolverWith(logger, { SERA_NETWORK_CLASS: 'datacenter' });
    await resolver.resolve('https://www.youtube.com/watch?v=x', undefined, 'req-42');

    const resolved = lines().find((line) => line.msg === 'resolved');
    expect(resolved, 'no resolve line was written').toBeDefined();
    expect(resolved).toMatchObject({
      requestId: 'req-42',
      provider: 'youtube',
      strategy: 'local',
      networkClass: 'datacenter',
      attempts: 1,
      mediaType: 'single',
      source: 'www.youtube.com/watch',
    });
    expect(resolved!.mediaKinds).toEqual(['video']);
    expect(typeof resolved!.durationMs).toBe('number');
  });

  it('classifies a failure rather than only naming its code', async () => {
    const { logger, lines } = capture();
    const resolver = new MediaResolver({
      config: loadConfig({
        NODE_ENV: 'test',
        SERA_SECRET: 'observability-secret',
        SERA_DATA_DIR: '.data/test',
      }),
      logger,
      probe: () => Promise.reject(new Error("Sign in to confirm you're not a bot")),
    });

    await resolver.resolve('https://www.youtube.com/watch?v=y').catch(() => undefined);

    const failed = lines().find((line) => line.msg === 'resolve failed');
    expect(failed, 'no failure line was written').toBeDefined();
    expect(failed).toMatchObject({ provider: 'youtube', failureClass: 'BOT_DETECTION' });
  });

  it('never records which video, only which site', async () => {
    const { logger, lines } = capture();
    await resolverWith(logger).resolve('https://www.youtube.com/watch?v=x');

    for (const line of lines()) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain('v=x');
      expect(serialized).not.toContain('googlevideo');
      expect(serialized).not.toContain('SECRETSIGNATURE');
    }
  });
});

describe('the lines a visitor import writes', () => {
  const signed =
    'https://scontent-vie1-1.cdninstagram.com/v/t51/SECRETPATH.jpg?oh=SECRETSIGNATURE&oe=FFFFFFFF';
  const node = (url: string) => ({
    code: 'ABC123',
    media_type: 1,
    image_versions2: { candidates: [{ url, width: 1080 }] },
  });

  it('say what an operator correlates on, and never which post or which media', () => {
    const { logger, lines } = capture();
    const resolver = new MediaResolver({
      config: loadConfig({
        NODE_ENV: 'test',
        SERA_SECRET: 'observability-secret',
        SERA_DATA_DIR: '.data/test',
      }),
      logger,
    });

    const post = 'https://www.instagram.com/p/ABC123/';
    resolver.importSubmitted({ url: post, node: node(signed) }, 'req-7');
    try {
      resolver.importSubmitted({
        url: post,
        node: node('https://evil.example/SECRETPATH.jpg?oh=SECRETSIGNATURE'),
      });
    } catch {
      // Refused, which is the point: a refusal writes a line as well.
    }

    const written = lines();
    expect(written.find((line) => line.msg === 'imported')).toMatchObject({
      requestId: 'req-7',
      provider: 'instagram',
      strategy: 'visitor-browser',
      source: 'www.instagram.com/p',
      items: 1,
    });
    expect(written.find((line) => line.msg === 'import refused')).toMatchObject({
      errorCode: 'BLOCKED_ADDRESS',
    });
    for (const line of written) {
      const serialized = JSON.stringify(line);
      for (const secret of ['SECRETPATH', 'SECRETSIGNATURE', 'ABC123', 'evil.example']) {
        expect(serialized, secret).not.toContain(secret);
      }
    }
  });
});

describe('the redaction list', () => {
  it('covers what a visitor import carries, wherever it is spread', () => {
    const { logger, lines } = capture();
    const entries = [
      { s: '1', kind: 'image', url: 'https://scontent.cdninstagram.com/v/a.jpg?oh=SIGNED' },
    ];
    logger.info(
      { imported: { entries }, spec: { imported: { entries } } },
      'a line that should say nothing',
    );
    expect(JSON.stringify(lines()[0])).not.toContain('SIGNED');
  });

  it('covers every kind of credential this service can hold', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        cookie: 'sessionid=abc',
        sessionId: 'abc',
        clientSecret: 'reddit-secret',
        accessToken: 'bearer-token',
        authorization: 'Bearer abc',
        mediaUrl: 'https://googlevideo.com/videoplayback?sig=abc',
        url: 'https://example.com/private/thing',
        nested: { token: 'abc', cookie: 'x', mediaUrl: 'https://y/z' },
      },
      'a line that should say nothing',
    );

    const serialized = JSON.stringify(lines()[0]);
    for (const secret of [
      'sessionid=abc',
      'reddit-secret',
      'bearer-token',
      'Bearer abc',
      'videoplayback',
      'private/thing',
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
  });
});

describe('logSafeUrl', () => {
  it('keeps the site and the shape, and nothing that identifies the post', () => {
    expect(logSafeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('www.youtube.com/watch');
    expect(logSafeUrl('https://www.instagram.com/p/ABC123/')).not.toContain('ABC123');
  });
});
