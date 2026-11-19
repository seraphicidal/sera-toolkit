import type { ServiceInfo } from '@sera/contracts/types';
import { getApiOrigin } from './backend-proxy';

export async function loadServiceInfo(): Promise<ServiceInfo | undefined> {
  try {
    const response = await fetch(`${getApiOrigin()}/api/info`, { next: { revalidate: 60 } });
    if (!response.ok) return undefined;
    return (await response.json()) as ServiceInfo;
  } catch {
    return undefined;
  }
}
