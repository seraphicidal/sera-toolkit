export interface RobotsRules {
  readonly groups: readonly { readonly allow: string[]; readonly disallow: string[] }[];
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agent = userAgent.toLowerCase();
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | undefined;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;
    if (field === 'allow' && value) current.allow.push(value);
    else if (field === 'disallow') current.disallow.push(value);
  }

  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const applicable = named.length ? named : wildcard;

  return { groups: applicable.map(({ allow, disallow }) => ({ allow, disallow })) };
}

function matches(pattern: string, path: string): number {
  if (pattern === '' || pattern.length > 512) return -1;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  if (!body.includes('*')) {
    const hit = anchored ? path === body : path.startsWith(body);
    return hit ? body.length : -1;
  }

  const parts = body.split('*');
  const first = parts[0]!;
  if (!path.startsWith(first)) return -1;

  let cursor = first.length;
  const last = parts[parts.length - 1]!;
  if (anchored && (!path.endsWith(last) || path.length - last.length < cursor)) {
    return -1;
  }

  const end = anchored ? path.length - last.length : path.length;
  const limit = anchored ? parts.length - 1 : parts.length;
  for (let i = 1; i < limit; i += 1) {
    const part = parts[i]!;
    if (!part) continue;
    const found = path.indexOf(part, cursor);
    if (found < 0 || found + part.length > end) return -1;
    cursor = found + part.length;
  }

  return body.length;
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  let bestAllow = -1;
  let bestDisallow = -1;

  for (const group of rules.groups) {
    for (const pattern of group.allow) bestAllow = Math.max(bestAllow, matches(pattern, path));
    for (const pattern of group.disallow) {
      if (pattern === '') continue;
      bestDisallow = Math.max(bestDisallow, matches(pattern, path));
    }
  }

  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}
