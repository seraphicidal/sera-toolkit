import type { ServiceInfo } from '@sera/contracts/types';

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
