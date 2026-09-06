import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from './robots.js';

const allow = (text: string, path: string, agent = 'sera-toolkit'): boolean =>
  isAllowed(parseRobots(text, agent), path);

describe('robots.txt', () => {
  it('allows everything when there are no rules', () => {
    expect(allow('', '/anything')).toBe(true);
    expect(allow('# just a comment', '/anything')).toBe(true);
  });

  it('honours a wildcard disallow', () => {
    const robots = 'User-agent: *\nDisallow: /private';
    expect(allow(robots, '/private/thing')).toBe(false);
    expect(allow(robots, '/public/thing')).toBe(true);
  });

  it('treats an empty Disallow as permission, not as a block', () => {
    expect(allow('User-agent: *\nDisallow:', '/anything')).toBe(true);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    const robots = 'User-agent: *\nDisallow: /media\nAllow: /media/public';
    expect(allow(robots, '/media/secret')).toBe(false);
    expect(allow(robots, '/media/public/x.mp4')).toBe(true);
  });

  it('prefers a group naming the agent over the wildcard group', () => {
    const robots = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: sera-toolkit',
      'Disallow: /admin',
    ].join('\n');
    expect(allow(robots, '/video')).toBe(true);
    expect(allow(robots, '/admin/panel')).toBe(false);
    // A different agent still gets the restrictive wildcard group.
    expect(allow(robots, '/video', 'other-bot')).toBe(false);
  });

  it('applies one rule set to consecutive User-agent lines', () => {
    const robots = 'User-agent: googlebot\nUser-agent: sera-toolkit\nDisallow: /x';
    expect(allow(robots, '/x/y')).toBe(false);
    expect(allow(robots, '/y')).toBe(true);
  });

  it('supports wildcards and end anchors', () => {
    const robots = 'User-agent: *\nDisallow: /*.pdf$';
    expect(allow(robots, '/docs/file.pdf')).toBe(false);
    expect(allow(robots, '/docs/file.pdf?x=1')).toBe(true);
    expect(allow(robots, '/docs/file.mp4')).toBe(true);
  });

  it('ignores comments and malformed lines', () => {
    const robots = 'User-agent: * # everyone\nDisallow: /private # secret\nnonsense line\n: broken';
    expect(allow(robots, '/private/x')).toBe(false);
    expect(allow(robots, '/other')).toBe(true);
  });

  it('handles a blanket disallow', () => {
    expect(allow('User-agent: *\nDisallow: /', '/')).toBe(false);
    expect(allow('User-agent: *\nDisallow: /', '/anything')).toBe(false);
  });
});
