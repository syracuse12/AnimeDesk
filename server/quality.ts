/**
 * HLS variant selection.
 *
 * The quality setting is a *preference*, never a promise. A provider rarely
 * publishes every rendition, so an explicit 480p on a manifest that only ships
 * 1080p and 720p must not silently play 1080p: that is the worst outcome for a
 * metered or slow connection, and it is indistinguishable from the request
 * being ignored.
 *
 * The rules, in order:
 *   1. an exact match wins;
 *   2. otherwise the highest rendition at or below the request;
 *   3. if every rendition is above the request, the lowest one.
 *
 * Anything other than an exact match is reported back so the interface can say
 * what is actually playing instead of echoing the preference.
 */

export interface Variant {
  height: number;
  url: string;
}

export interface QualityPick {
  /** Chosen URL, or the untouched master when the manifest listed no variants. */
  url: string;
  /** Height of the chosen rendition, null when it could not be determined. */
  height: number | null;
  /** True when the request could not be honoured exactly. */
  fellBack: boolean;
  /** Human wording for the player, null when the request was met exactly. */
  note: string | null;
}

function label(height: number): string {
  return height > 0 ? `${height}p` : 'the only rendition';
}

/**
 * Choose a rendition for `requested` ('best', 'worst' or a height). `variants`
 * may be unsorted and may contain zero-height entries for manifests without a
 * RESOLUTION attribute; those sort last and are only chosen as a last resort.
 */
export function pickVariant(variants: Variant[], requested: string, masterUrl: string): QualityPick {
  const usable = variants.filter((variant) => typeof variant.url === 'string' && variant.url.length > 0);
  if (!usable.length) {
    return { url: masterUrl, height: null, fellBack: false, note: null };
  }

  const sorted = [...usable].sort((a, b) => b.height - a.height);
  const highest = sorted[0] as Variant;
  const lowest = sorted[sorted.length - 1] as Variant;

  if (requested === 'best') {
    return { url: highest.url, height: highest.height || null, fellBack: false, note: null };
  }
  if (requested === 'worst') {
    return { url: lowest.url, height: lowest.height || null, fellBack: false, note: null };
  }

  const wanted = Number(requested);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { url: highest.url, height: highest.height || null, fellBack: false, note: null };
  }

  const exact = sorted.find((variant) => variant.height === wanted);
  if (exact) return { url: exact.url, height: exact.height, fellBack: false, note: null };

  const below = sorted.find((variant) => variant.height > 0 && variant.height <= wanted);
  if (below) {
    return {
      url: below.url,
      height: below.height,
      fellBack: true,
      note: `${label(wanted)} is not offered; playing ${label(below.height)}, the highest available at or below it.`,
    };
  }

  // Everything is above the request: the lowest rendition is the closest fit.
  return {
    url: lowest.url,
    height: lowest.height || null,
    fellBack: true,
    note: `${label(wanted)} is not offered; playing ${label(lowest.height)}, the lowest available.`,
  };
}

/** Parse RESOLUTION / BANDWIDTH lines out of a master playlist. */
export function parseVariants(playlist: string, base: string, resolve: (value: string, base: string) => string | null): Variant[] {
  const lines = playlist.split('\n');
  const variants: Variant[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    if (/EXT-X-I-FRAME/.test(line)) continue;
    const height = Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? 0);
    const next = lines[index + 1]?.trim() ?? '';
    if (!next || next.startsWith('#')) continue;
    const url = resolve(next, base);
    if (url) variants.push({ height, url });
  }
  return variants;
}