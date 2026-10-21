import { describe, expect, it } from 'vitest';
import { isIpLiteral, isPublicAddress, unwrapIpv4Mapped } from './ip.js';

describe('isPublicAddress', () => {
  it('accepts routable addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '142.250.185.78', '2606:4700:4700::1111']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('rejects every range that reaches infrastructure rather than the internet', () => {
    const blocked = [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.31.9',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '169.254.0.1',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
    ];
    for (const address of blocked) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('rejects loopback and private ranges across IPv6 transition and tunneling prefixes', () => {
    for (const address of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::FFFF:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '::127.0.0.1',
      '::ffff:0:127.0.0.1',
      '64:ff9b::127.0.0.1',
      '64:ff9b:1::1',
      '2001:0::1',
      '2002:7f00:1::',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('accepts a mapped public address in both compressed and expanded forms', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicAddress('0:0:0:0:0:ffff:8.8.8.8')).toBe(true);
  });

  it('ignores a zone index', () => {
    expect(isPublicAddress('fe80::1%eth0')).toBe(false);
  });

  it('rejects anything that is not an address at all', () => {
    for (const value of ['', 'example.com', '999.999.999.999', '127.0.0.1.evil.com', 'not-an-ip']) {
      expect(isPublicAddress(value), value).toBe(false);
    }
  });
});

describe('unwrapIpv4Mapped', () => {
  it('reads compressed, expanded, dotted, and hex spellings', () => {
    expect(unwrapIpv4Mapped('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(unwrapIpv4Mapped('::ffff:c0a8:1')).toBe('192.168.0.1');
    expect(unwrapIpv4Mapped('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(unwrapIpv4Mapped('0:0:0:0:0:ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(unwrapIpv4Mapped('0000:0000:0000:0000:0000:ffff:7f00:0001')).toBe('127.0.0.1');
  });

  it('returns nothing for an address that is not mapped', () => {
    expect(unwrapIpv4Mapped('2001:4860:4860::8888')).toBeUndefined();
    expect(unwrapIpv4Mapped('8.8.8.8')).toBeUndefined();
  });
});

describe('isIpLiteral', () => {
  it('recognises bare and bracketed addresses', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});
