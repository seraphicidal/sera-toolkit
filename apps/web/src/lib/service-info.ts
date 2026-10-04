import type { ServiceInfo } from '@sera/contracts/types';

/**
 * The running API's description of itself, for server components.
 *
 * Read at render time and cached for a minute, so the pages that list sources describe the
 * deployment the visitor is actually using. Undefined when the API cannot be reached — at
 * image build time, for one — and every caller renders without it.
 */
const API_ORIGIN = (process.env.SERA_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

export async function loadServiceInfo(): Promise<ServiceInfo | undefined> {
  try {
    const response = await fetch(`${API_ORIGIN}/api/info`, { next: { revalidate: 60 } });
    if (!response.ok) return undefined;
    return (await response.json()) as ServiceInfo;
  } catch {
    return undefined;
  }
}
