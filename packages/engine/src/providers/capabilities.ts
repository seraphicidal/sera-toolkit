import type { ProviderCapabilities } from '@sera/contracts/types';

/**
 * One place where a provider says what it can do, so the router stops guessing.
 *
 * Before this, "should a residential node be asked?" was a conditional in the router
 * that knew about failure classes and nothing about providers. That is only half the
 * question. A bot challenge on YouTube is worth another network; the same class from
 * Instagram is not, because Instagram refuses photographs to *any* anonymous address —
 * measured from a home connection as well as from the datacentre. The failure says the
 * attempt was refused; the provider says whether a different address would change it.
 *
 * Every field is required in the contract so a new provider cannot quietly inherit a
 * claim nobody checked. `declare` supplies the defaults for the common case — a
 * yt-dlp-backed video site with no credentials — and each provider states its
 * differences, which is the part worth reading.
 */
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
};

/** A provider's capabilities: the defaults above, with its differences applied. */
export function declare(differences: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...differences };
}
