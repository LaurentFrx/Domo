/**
 * Règles « playlist intelligente » → requête de filtres Plex (pistes, type=10).
 *
 * Le même vocabulaire sert aux DEUX usages :
 *   - mix immédiat  : GET /library/sections/<key>/all?<query>  (POST /api/plex/smart)
 *   - vraie playlist intelligente Plex : POST /playlists?smart=1&uri=…<query>
 *     (elle se met à jour toute seule côté serveur, comme dans PlexAmp).
 *
 * Opérateurs Plex : `>>=` (≥ / après), `<<=` (≤ / avant), dates relatives `-30d`.
 * Tout est validé/clampé ici — jamais de paramètre client relayé brut.
 */
import { PlexError } from './plex';

export interface SmartRules {
  /** Années d'album (bornes incluses). */
  yearFrom?: number;
  yearTo?: number;
  /** Ajouté dans les X derniers jours. */
  addedDays?: number;
  /** Pas écouté depuis X jours (implique d'avoir déjà été écouté). */
  notPlayedDays?: number;
  /** Uniquement des titres déjà écoutés. */
  playedOnly?: boolean;
  /** Uniquement des titres jamais écoutés. */
  neverPlayed?: boolean;
  /** Note perso minimale (échelle Plex 0-10 ; 8 = 4★). */
  minRating?: number;
  sort?: 'random' | 'added' | 'plays' | 'alpha' | 'recent';
  limit?: number;
}

const SORTS: Record<NonNullable<SmartRules['sort']>, string> = {
  random: 'random',
  added: 'addedAt:desc',
  plays: 'viewCount:desc',
  alpha: 'titleSort',
  recent: 'lastViewedAt:desc'
};

function intIn(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Construit la query (sans `?`) ; jette PlexError(400) sur règle invalide. */
export function smartQuery(rules: SmartRules): string {
  const p: string[] = ['type=10'];

  if (rules.yearFrom !== undefined) {
    const y = intIn(rules.yearFrom, 1900, 2100);
    if (y === null) throw new PlexError(400, 'Année « de » invalide');
    p.push(`album.year>>=${y}`);
  }
  if (rules.yearTo !== undefined) {
    const y = intIn(rules.yearTo, 1900, 2100);
    if (y === null) throw new PlexError(400, 'Année « à » invalide');
    p.push(`album.year<<=${y}`);
  }
  if (rules.addedDays !== undefined) {
    const d = intIn(rules.addedDays, 1, 3650);
    if (d === null) throw new PlexError(400, 'Fenêtre d’ajout invalide');
    p.push(`addedAt>>=-${d}d`);
  }
  if (rules.notPlayedDays !== undefined) {
    const d = intIn(rules.notPlayedDays, 1, 3650);
    if (d === null) throw new PlexError(400, 'Fenêtre d’écoute invalide');
    p.push(`lastViewedAt<<=-${d}d`);
  }
  if (rules.neverPlayed) {
    p.push('viewCount=0');
  } else if (rules.playedOnly || rules.notPlayedDays !== undefined) {
    p.push('viewCount>>=1');
  }
  if (rules.minRating !== undefined) {
    const r = intIn(rules.minRating, 1, 10);
    if (r === null) throw new PlexError(400, 'Note minimale invalide');
    p.push(`userRating>>=${r}`);
  }

  p.push(`sort=${SORTS[rules.sort ?? 'random']}`);
  p.push(`limit=${intIn(rules.limit, 1, 500) ?? 100}`);
  return p.join('&');
}
