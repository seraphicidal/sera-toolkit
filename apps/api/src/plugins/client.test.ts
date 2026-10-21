import { describe, expect, it } from 'vitest';
import { normalizeClientAddress } from './client.js';

describe('normalizeClientAddress', () => {
  it('preserves native IPv4 addresses', () => {
    expect(normalizeClientAddress('192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeClientAddress('127.0.0.1')).toBe('127.0.0.1');
  });

  it('normalizes IPv4-mapped IPv6 to native IPv4', () => {
    expect(normalizeClientAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeClientAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientAddress('[::ffff:10.0.0.1]')).toBe('10.0.0.1');
  });

  it('normalizes IPv6 addresses to their /64 prefix', () => {
    expect(normalizeClientAddress('2001:0db8:85a3:08d3:1319:8a2e:0370:7334')).toBe(
      '2001:db8:85a3:8d3::/64',
    );
    expect(normalizeClientAddress('2001:db8:85a3:8d3::1')).toBe('2001:db8:85a3:8d3::/64');
    expect(normalizeClientAddress('2001:db8:85a3:8d3:ffff:ffff:ffff:ffff')).toBe(
      '2001:db8:85a3:8d3::/64',
    );
  });

  it('normalizes compressed IPv6 addresses in the same /64 to the same prefix', () => {
    const a = normalizeClientAddress('2001:db8::1');
    const b = normalizeClientAddress('2001:db8::2');
    const c = normalizeClientAddress('2001:db8:0:0:ffff::1');
    expect(a).toBe('2001:db8:0:0::/64');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('strips brackets and zone identifiers', () => {
    expect(normalizeClientAddress('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
    expect(normalizeClientAddress('2001:db8::1%eth0')).toBe('2001:db8:0:0::/64');
  });
});
