import type { ProviderId } from '../../shared/types.ts';
import type { Provider } from './types.ts';
import { ProviderError } from './types.ts';
import { localProvider } from './local.ts';

/** Registration order is display order in the UI. */
export const distributionProfile = process.env.ANIMEDESK_PROFILE === 'distribution';
const registry = new Map<ProviderId, Provider>();
// The release ships the hianime catalogue plus the local library. Archive stays
// development-only: its catalogue needs a per-item rights check and every play
// needs a live lookup.
if (distributionProfile) {
  const { hianimeProvider } = await import('./hianime.ts');
  registry.set('hianime', hianimeProvider);
} else {
  const [{ hianimeProvider }, { archiveProvider }] = await Promise.all([
    import('./hianime.ts'), import('./archive.ts'),
  ]);
  registry.set('hianime', hianimeProvider);
  registry.set('archive', archiveProvider);
}
registry.set('local', localProvider);

/** Swap a provider out; the tests use this to avoid the network. */
export function registerProvider(id: ProviderId, provider: Provider): void {
  if (distributionProfile && id === 'archive') throw new Error('Provider disabled in distribution profile');
  registry.set(id, provider);
}

export function getProvider(id: string): Provider {
  const provider = registry.get(id as ProviderId);
  if (!provider) throw new ProviderError(distributionProfile ? 403 : 404, `Provider unavailable: ${id}`);
  return provider;
}

export function providerInfos() {
  return [...registry.values()].map((provider) => provider.info);
}

export function searchableProviders(): ProviderId[] {
  return [...registry.entries()].filter(([, provider]) => provider.info.searchable).map(([id]) => id);
}
