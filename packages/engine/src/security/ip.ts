import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Address ranges the server must never be talked into connecting to.
 *
 * The list is deny-by-range rather than allow-by-range because the public internet is
 * not enumerable, and it covers the ranges that reach infrastructure rather than the
 * internet: loopback, link-local (including the cloud metadata endpoints at 169.254.x),
 * every private block, carrier-grade NAT, and the various documentation and reserved
 * spaces that resolve to something unexpected often enough to matter.
 */
const blocked = new BlockList();

// IPv4
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network"
blocked.addSubnet('10.0.0.0', 8, 'ipv4'); // private
blocked.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT
blocked.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, incl. cloud metadata
blocked.addSubnet('172.16.0.0', 12, 'ipv4'); // private
blocked.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
blocked.addSubnet('192.0.2.0', 24, 'ipv4'); // TEST-NET-1
blocked.addSubnet('192.31.196.0', 24, 'ipv4'); // AS112
blocked.addSubnet('192.168.0.0', 16, 'ipv4'); // private
blocked.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
blocked.addSubnet('198.51.100.0', 24, 'ipv4'); // TEST-NET-2
blocked.addSubnet('203.0.113.0', 24, 'ipv4'); // TEST-NET-3
blocked.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, incl. 255.255.255.255

// IPv6
//
// The IPv4-mapped range `::ffff:0:0/96` is deliberately absent. Node's BlockList maps an
// IPv4 argument into that range before comparing, so adding it here would make
// `check('8.8.8.8', 'ipv4')` true and block the entire IPv4 internet. Mapped addresses
// are handled correctly by unwrapping them and re-checking as IPv4, in `isPublicAddress`.
blocked.addAddress('::', 'ipv6'); // unspecified
blocked.addAddress('::1', 'ipv6'); // loopback
blocked.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64
blocked.addSubnet('100::', 64, 'ipv6'); // discard-only
blocked.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
blocked.addSubnet('fc00::', 7, 'ipv6'); // unique local
blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local
blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast

/** Extracts the embedded IPv4 address from `::ffff:a.b.c.d` and `::ffff:aabb:ccdd`. */
export function unwrapIpv4Mapped(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return undefined;
}

/**
 * True when `address` is a routable public address.
 *
 * IPv4-mapped IPv6 is unwrapped first: `::ffff:127.0.0.1` is loopback however it is
 * spelled, and treating the two spellings differently is a classic bypass.
 */
export function isPublicAddress(address: string): boolean {
  const trimmed = address.trim().replace(/%.*$/, ''); // drop any zone index
  if (isIPv4(trimmed)) return !blocked.check(trimmed, 'ipv4');
  if (isIPv6(trimmed)) {
    const mapped = unwrapIpv4Mapped(trimmed);
    if (mapped) return isIPv4(mapped) && !blocked.check(mapped, 'ipv4');
    return !blocked.check(trimmed, 'ipv6');
  }
  return false;
}

/** True when `hostname` is a literal IP address rather than a name. */
export function isIpLiteral(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIPv4(bare) || isIPv6(bare);
}
