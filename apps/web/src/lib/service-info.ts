import type { ServiceInfo } from '@sera/contracts/types';
import { getApiOrigin } from './backend-proxy';

const SERVICE_INFO_TIMEOUT_MS = 3_000;

export async function loadServiceInfo(): Promise<ServiceInfo | undefined> {
  try {
    const response = await fetch(`${getApiOrigin()}/api/info`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(SERVICE_INFO_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as ServiceInfo;
  } catch {
    return undefined;
  }
}
