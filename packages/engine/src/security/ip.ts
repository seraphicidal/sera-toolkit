import { BlockList, isIPv4, isIPv6 } from 'node:net';

const blocked = new BlockList();

blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.0.0.0', 24, 'ipv4');
blocked.addSubnet('192.0.2.0', 24, 'ipv4');
blocked.addSubnet('192.31.196.0', 24, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('198.18.0.0', 15, 'ipv4');
blocked.addSubnet('198.51.100.0', 24, 'ipv4');
blocked.addSubnet('203.0.113.0', 24, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addSubnet('240.0.0.0', 4, 'ipv4');

blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('::', 96, 'ipv6');
blocked.addSubnet('::ffff:0:0:0', 96, 'ipv6');
blocked.addSubnet('64:ff9b::', 96, 'ipv6');
blocked.addSubnet('64:ff9b:1::', 48, 'ipv6');
blocked.addSubnet('100::', 64, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('fec0::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

function parseIpv6Words(address: string): number[] | undefined {
  const bare = address.toLowerCase().trim().replace(/%.*$/, '');
  if (!bare) return undefined;
  const firstDc = bare.indexOf('::');
  if (firstDc !== -1 && bare.includes('::', firstDc + 2)) return undefined;

  const headParts =
    firstDc !== -1
      ? bare.slice(0, firstDc)
        ? bare.slice(0, firstDc).split(':')
        : []
      : bare.split(':');
  const tailParts =
    firstDc !== -1 ? (bare.slice(firstDc + 2) ? bare.slice(firstDc + 2).split(':') : []) : [];

  const expand = (parts: string[], allowV4: boolean): number[] | undefined => {
    const words: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (!part) return undefined;
      if (part.includes('.')) {
        if (!allowV4 || i !== parts.length - 1 || !isIPv4(part)) return undefined;
        const octets = part.split('.').map(Number);
        words.push(((octets[0]! << 8) | octets[1]!) >>> 0, ((octets[2]! << 8) | octets[3]!) >>> 0);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
        words.push(parseInt(part, 16));
      }
    }
    return words;
  };

  const headWords = expand(headParts, tailParts.length === 0);
  const tailWords = expand(tailParts, true);
  if (!headWords || !tailWords) return undefined;

  if (firstDc !== -1) {
    const missing = 8 - (headWords.length + tailWords.length);
    if (missing < 1) return undefined;
    return [...headWords, ...new Array<number>(missing).fill(0), ...tailWords];
  }
  return headWords.length === 8 ? headWords : undefined;
}

function unwrapWords(words: number[]): string | undefined {
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const high = words[6]!;
    const low = words[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return undefined;
}

export function unwrapIpv4Mapped(address: string): string | undefined {
  const words = parseIpv6Words(address);
  return words ? unwrapWords(words) : undefined;
}

export function isPublicAddress(address: string): boolean {
  const trimmed = address.trim().replace(/%.*$/, '');
  if (isIPv4(trimmed)) return !blocked.check(trimmed, 'ipv4');
  if (isIPv6(trimmed)) {
    const words = parseIpv6Words(trimmed);
    if (!words) return false;
    const mapped = unwrapWords(words);
    if (mapped) return isIPv4(mapped) && !blocked.check(mapped, 'ipv4');
    if ((words[0]! & 0xff00) === 0) return false;
    return !blocked.check(trimmed, 'ipv6');
  }
  return false;
}

export function isIpLiteral(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIPv4(bare) || isIPv6(bare);
}
