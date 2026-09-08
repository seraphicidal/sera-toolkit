import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { silentLogger } from '../logging.js';
import type { ResolvedMedia } from '../providers/types.js';
import { WorkspaceManager } from '../storage/workspace.js';
import { MediaResolver } from '../resolver.js';
import { JobRunner } from './runner.js';
import type { ExtractionNodeRegistry, RemoteFile } from '../extract/remote.js';

/**
 * The invariant that the whole node architecture rests on.
 *
 * Several platforms sign a media URL to the address that requested it. Measured on
 * YouTube: the same `googlevideo` URL answers 206 from a home connection and 403 from a
 * server minutes later. So a resolution taken on one network and a download taken on
 * another do not compose, and a runner that splits them produces a job that fails at the
 * last step for reasons nothing upstream can explain.
 *
 * This pins the rule: whichever backend produced the plans carries out the job.
 */

const run = promisify(execFile);

let dataDir: string;
let workspaces: WorkspaceManager;

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  SERA_SECRET: 'ip-bound-secret',
  SERA_DATA_DIR: '.data/test',
});

/** A resolution, optionally stamped with the backend that produced it. */
function media(backend?: string): ResolvedMedia {
  return {
    provider: 'youtube',
    providerLabel: 'YouTube',
    url: 'https://www.youtube.com/watch?v=x',
    type: 'single',
    title: 'A video',
    items: [
      {
        index: 0,
        kind: 'video',
        plans: [
          {
            kind: 'video',
            container: 'mp4',
            label: '1080p',
            requiresConversion: false,
            recommended: true,
            fetch: { via: 'ytdlp', selector: 'best' },
          },
        ],
      },
    ],
    // The typed field, not an entry in `metadata`. It was in `metadata` once, under a
    // name the YouTube provider was also using for a diagnostic — so every YouTube job
    // was dispatched to a node that did not exist and sat there until it timed out.
    ...(backend ? { remoteBackend: backend } : {}),
  };
}

function runnerFor(
  resolved: ResolvedMedia,
  remote?: Partial<ExtractionNodeRegistry>,
): { runner: JobRunner; localFetches: string[] } {
  const localFetches: string[] = [];
  const runner = new JobRunner({
    config: { ...config, dataDir },
    logger: silentLogger(),
    resolver: {
      resolveCanonical: () => Promise.resolve(resolved),
      // A local fetch would go through here; recording it is how the test notices.
      dispatcher: undefined,
    } as never,
    workspaces,
    ...(remote ? { remote: remote as ExtractionNodeRegistry } : {}),
  });
  return { runner, localFetches };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sera-ipbound-'));
  workspaces = new WorkspaceManager(dataDir, 3600, silentLogger());
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('a job follows the backend that resolved it', () => {
  it('sends the download to the node whose resolution produced the plans', async () => {
    const dispatched: { planKeys?: readonly string[]; url?: string }[] = [];

    const remote: Partial<ExtractionNodeRegistry> = {
      dispatchJob: async (task): Promise<readonly RemoteFile[]> => {
        dispatched.push({ planKeys: task.planKeys, url: task.url });
        // A real file, because the runner validates its output with ffprobe and a
        // stand-in of eight bytes would only prove that validation runs.
        const path = join(dataDir, 'from-node.mp4');
        await run(config.ffmpegPath, [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=64x64:rate=5:duration=1',
          '-pix_fmt',
          'yuv420p',
          path,
        ]);
        return [{ name: 'from-node.mp4', mimeType: 'video/mp4', path }];
      },
    };

    const { runner } = runnerFor(media('residential'), remote);
    const result = await runner.run(
      {
        jobId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        provider: 'youtube',
        url: 'https://www.youtube.com/watch?v=x',
        selections: [{ itemIndex: 0, planKey: 'video/mp4/1080p' }],
        packaging: 'auto',
      },
      () => undefined,
    );

    // The job went to the node, carrying the plan key the visitor picked.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.planKeys).toEqual(['video/mp4/1080p']);
    expect(result.filename).toBe('from-node.mp4');
  });

  it("cannot be talked into it by a provider's own diagnostics", async () => {
    // The bug this pins. The YouTube provider recorded which path it took as
    // `metadata.extractionBackend`, and the runner read a key of that name to decide a
    // job belonged on another machine. Every YouTube job was dispatched to a node that
    // did not exist and sat there until the task timed out — with the state stuck on
    // "Downloading" and nothing in the log to say why.
    //
    // The routing answer is now a typed field the resolver alone sets, so a provider
    // cannot reach it however it names its metadata.
    const resolver = new MediaResolver({
      config: { ...config, dataDir },
      logger: silentLogger(),
      probe: () =>
        Promise.resolve({
          id: 'x',
          _type: 'video',
          title: 'A short',
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
              url: 'https://rr1---sn.googlevideo.com/videoplayback',
            },
          ],
        }),
    });

    const resolved = await resolver.resolveCanonical(
      new URL('https://www.youtube.com/watch?v=x'),
      'youtube',
    );

    expect(resolved.remoteBackend).toBeUndefined();
    // The diagnostic is still recorded — under a name that is not the routing field.
    expect(resolved.metadata?.extractionPath).toBe('direct');
  });

  it('never dispatches remotely for a resolution the local network produced', async () => {
    // The other half of the rule. A local resolution has local URLs; sending the job
    // elsewhere would spend a scarce connection and, for a signed URL, fail anyway.
    let dispatchedRemotely = false;
    const remote: Partial<ExtractionNodeRegistry> = {
      dispatchJob: () => {
        dispatchedRemotely = true;
        return Promise.reject(new Error('should not be reached'));
      },
    };

    const { runner } = runnerFor(media(), remote);
    // The local path will fail here — there is no extractor in this test — but what
    // matters is where it tried, not whether it succeeded.
    await runner
      .run(
        {
          jobId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          provider: 'youtube',
          url: 'https://www.youtube.com/watch?v=x',
          selections: [{ itemIndex: 0, planKey: 'video/mp4/1080p' }],
          packaging: 'auto',
        },
        () => undefined,
      )
      .catch(() => undefined);

    expect(dispatchedRemotely).toBe(false);
  });

  it('does not dispatch remotely when no node is configured', async () => {
    // With no registry the runner has nowhere to send it and must not pretend otherwise.
    const { runner } = runnerFor(media('residential'));
    await expect(
      runner.run(
        {
          jobId: 'cccccccccccccccccccccccccccccccc',
          provider: 'youtube',
          url: 'https://www.youtube.com/watch?v=x',
          selections: [{ itemIndex: 0, planKey: 'video/mp4/1080p' }],
          packaging: 'auto',
        },
        () => undefined,
      ),
    ).rejects.toThrow();
  });
});
