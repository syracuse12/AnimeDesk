import type { ProviderId } from '../../shared/types.ts';
import type { Provider } from './types.ts';
import { hianimeProvider } from './hianime.ts';
import { archiveProvider } from './archive.ts';
import { localProvider } from './local.ts';

/** Registration order is display order in the UI. */
const registry = new Map<ProviderId, Provider>([
  ['hianime', hianimeProvider],
  ['archive', archiveProvider],
  ['local', localProvider],
]);

export function getProvider(id: string): Provider {
  const provider = registry.get(id as ProviderId);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function providerInfos() {
  return [...registry.values()].map((provider) => provider.info);
}

export function searchableProviders(): ProviderId[] {
  return [...registry.entries()].filter(([, provider]) => provider.info.searchable).map(([id]) => id);
}