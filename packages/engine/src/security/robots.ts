/**
 * A minimal robots.txt evaluator.
 *
 * SERA only ever fetches the one page a person pasted, so it is not a crawler in the
 * sense robots.txt was written for. Honouring an explicit `Disallow` is still the right
 * default: a site that has said it does not want automated fetches of a path should not
 * have to say it twice.
 */

export interface RobotsRules {
  /** Rules that apply to the given agent, most specific group first. */
  readonly groups: readonly { readonly allow: string[]; readonly disallow: string[] }[];
}

/**
 * Parses robots.txt, keeping only the group that applies to `userAgent`.
 *
 * A named group wins over `*`, matching the convention every major crawler follows.
 */
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
      // Consecutive User-agent lines share one group of rules.
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

/** Turns a robots path pattern into a matcher, supporting `*` and a trailing `$`. */
function matches(pattern: string, path: string): number {
  if (pattern === '') return -1;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  if (!body.includes('*')) {
    const hit = anchored ? path === body : path.startsWith(body);
    return hit ? body.length : -1;
  }

  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
  return regex.test(path) ? body.length : -1;
}

/**
 * Whether `path` may be fetched.
 *
 * The longest matching rule wins, and `Allow` beats `Disallow` at equal length — the
 * behaviour Google documents and most sites are written against.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  let bestAllow = -1;
  let bestDisallow = -1;

  for (const group of rules.groups) {
    for (const pattern of group.allow) bestAllow = Math.max(bestAllow, matches(pattern, path));
    for (const pattern of group.disallow) {
      // An empty Disallow means "allow everything" and must not be treated as a match.
      if (pattern === '') continue;
      bestDisallow = Math.max(bestDisallow, matches(pattern, path));
    }
  }

  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}
