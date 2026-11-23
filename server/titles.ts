/**
 * Title comparison shared by the AniList resolver and the AniSkip lookup.
 *
 * Providers append release qualifiers to titles — hianime's romaji attribute
 * for Classroom of the Elite is "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu
 * e (TV)" while AniList stores it without the suffix. Those qualifiers used to
 * break the match outright, which silently disabled every skip lookup. They
 * are stripped first, and the remaining comparison stays strict so that
 * "Naruto" still does not match "Naruto Shippuuden".
 */

/** Release qualifiers that never change which show a title refers to. */
const QUALIFIERS = new Set(['tv', 'dub', 'sub', 'movie', 'ova', 'ona', 'special', 'uncensored', 'hd', 'sd']);

/** Reduce a title to comparable words: lowercase, no punctuation, no qualifiers. */
export function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // "(TV)", "(Dub)", "[Uncensored]" style suffixes, before punctuation dies.
    .replace(/\(\s*(tv|dub|sub|movie|ova|ona|special|uncensored|hd|sd)\s*\)/g, ' ')
    .replace(/\[\s*(tv|dub|sub|movie|ova|ona|special|uncensored|hd|sd)\s*\]/g, ' ')
    .replace(/\b(season|part|cour)\s*\d+\b/g, ' ')
    .replace(/\b(s\d+|\d+(st|nd|rd|th)\s+season)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A title as it should be *searched*, with release qualifiers removed.
 *
 * AniList does not tokenise "(TV)" away: the romaji title the provider reports
 * for Classroom of the Elite, "Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e
 * (TV)", returns an empty result set, while the bare title returns the entry.
 * Qualifiers are stripped for the query only — matching still runs against the
 * untouched title, so the strictness above is unchanged.
 */
export function searchTitle(input: string): string {
  return input
    .replace(/\(\s*(tv|dub|sub|movie|ova|ona|special|uncensored|hd|sd)\s*\)/gi, ' ')
    .replace(/\[\s*(tv|dub|sub|movie|ova|ona|special|uncensored|hd|sd)\s*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the candidate title is the same show, not merely similar.
 *
 * Accepts an exact match, the same words with different spacing, or a match
 * where one side only adds qualifier words ("Naruto" vs "Naruto (Dub)").
 * A differing non-qualifier word means a different show.
 */
export function titlesMatch(wanted: string, candidate: string): boolean {
  const a = normalizeTitle(wanted);
  const b = normalizeTitle(candidate);
  if (!a || !b) return false;
  if (a === b) return true;

  const at = a.split(' ');
  const bt = b.split(' ');
  if (at.length === bt.length) return a.replace(/ /g, '') === b.replace(/ /g, '');

  // Only qualifier words may differ, and only as a trailing addition.
  const [short, long] = at.length < bt.length ? [at, bt] : [bt, at];
  const extra = long.slice(short.length);
  if (!extra.length || extra.length > 2) return false;
  if (!extra.every((word) => QUALIFIERS.has(word))) return false;
  return short.every((word, index) => word === long[index]);
}