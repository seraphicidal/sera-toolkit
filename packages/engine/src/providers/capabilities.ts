import type { ProviderCapabilities } from '@sera/contracts/types';

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  video: true,
  image: false,
  audio: false,
  audioExtraction: true,
  carousel: false,
  gallery: false,
  gif: false,
  live: false,
  authenticatedMode: false,
  requiresOauth: false,
  residentialFallback: true,
  cloudExtraction: true,
  browserImport: false,
};

export function declare(differences: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...differences };
}
