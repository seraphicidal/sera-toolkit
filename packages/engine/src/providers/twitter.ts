import { YtdlpProvider } from './ytdlp-base.js';

/**
 * X, formerly Twitter, plus the legacy and mobile hostnames.
 *
 * What the interface calls a GIF is stored as a silent, short MP4, so the provider opts
 * into offering a real GIF conversion alongside the video rather than pretending the
 * source file is something it is not.
 */
export class TwitterProvider extends YtdlpProvider {
  readonly id = 'twitter';
  readonly label = 'X';
  readonly hosts = [
    'x.com',
    'twitter.com',
    'mobile.twitter.com',
    't.co',
    'vxtwitter.com',
    'fxtwitter.com',
  ];
  override readonly priority = 20;

  override normalize(url: URL): URL {
    const out = new URL(url.toString());
    // The mirror front-ends exist to fix embeds; the extractor wants the real host.
    out.hostname = 'x.com';
    out.protocol = 'https:';
    // /i/status/<id> and /<user>/status/<id> are the same post.
    out.pathname = out.pathname.replace(/\/(photo|video)\/\d+$/, '');
    return out;
  }

  protected override treatsSilentShortVideoAsGif(): boolean {
    return true;
  }
}
