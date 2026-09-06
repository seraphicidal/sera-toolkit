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
      '127.0.0.1', // loopback
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.5', // private
      '172.16.31.9',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '169.254.0.1',
      '100.64.0.1', // carrier-grade NAT
      '198.18.0.1', // benchmarking
      '224.0.0.1', // multicast
      '255.255.255.255',
      '::1', // v6 loopback
      '::',
      'fe80::1', // link-local
      'fc00::1', // unique local
      'fd12:3456::1',
      'ff02::1', // multicast
    ];
    for (const address of blocked) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('rejects loopback however it is spelled in IPv6', () => {
    // The classic bypass: the same address in a notation the check forgot about.
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:7f00:1')).toBe(false);
    expect(isPublicAddress('::FFFF:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:169.254.169.254')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
  });

  it('accepts a mapped public address', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
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
  it('reads both the dotted and the hex spellings', () => {
    expect(unwrapIpv4Mapped('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(unwrapIpv4Mapped('::ffff:c0a8:1')).toBe('192.168.0.1');
    expect(unwrapIpv4Mapped('::ffff:7f00:1')).toBe('127.0.0.1');
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
