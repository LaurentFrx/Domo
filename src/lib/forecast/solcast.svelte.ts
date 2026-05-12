/**
 * Store client pour les prévisions Solcast (Svelte 5 Runes).
 *
 * - Tape /api/solcast/forecast (proxy serveur, voir +server.ts).
 * - Throttle 4h : un refresh() qui suit un autre refresh() < 4h
 *   ne déclenche pas de fetch.
 * - Persistance localStorage pour survivre aux reloads et au
 *   mode offline du PWA.
 */

import type { ForecastPoint, ForecastResponse } from './types';

const CACHE_KEY = 'solcast.cache.v1';
const THROTTLE_MS = 4 * 60 * 60 * 1000; // 4 heures
const FORECAST_ENDPOINT = '/api/solcast/forecast';

interface CachedPayload {
  points: ForecastPoint[];
  lastUpdate: string; // ISO
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function readCache(): CachedPayload | null {
  if (!isBrowser()) return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!Array.isArray(parsed.points) || typeof parsed.lastUpdate !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(payload: CachedPayload): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Quota plein ou mode privé : on ignore silencieusement.
  }
}

export class SolcastStore {
  points = $state<ForecastPoint[]>([]);
  lastUpdate = $state<Date | null>(null);
  isLoading = $state(false);
  lastError = $state<string | null>(null);

  constructor() {
    // Restauration au boot : on évite un "flash vide" côté UI.
    const cached = readCache();
    if (cached) {
      this.points = cached.points;
      this.lastUpdate = new Date(cached.lastUpdate);
    }
  }

  /**
   * Récupère la prévision si le cache local a plus de THROTTLE_MS,
   * sinon ne fait rien (réutilise l'état déjà chargé).
   */
  async refresh(): Promise<void> {
    if (this.lastUpdate) {
      const age = Date.now() - this.lastUpdate.getTime();
      if (age < THROTTLE_MS) return;
    }
    await this.fetchNow();
  }

  /** Force un refresh, ignore le throttle 4h. */
  async forceRefresh(): Promise<void> {
    await this.fetchNow();
  }

  private async fetchNow(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    this.lastError = null;
    try {
      const res = await fetch(FORECAST_ENDPOINT, {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) {
        // Le proxy renvoie un body texte en cas d'erreur (SvelteKit `error()`).
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as ForecastResponse;
      this.points = body.points;
      this.lastUpdate = new Date(body.fetchedAt);
      writeCache({ points: this.points, lastUpdate: this.lastUpdate.toISOString() });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Erreur inconnue';
    } finally {
      this.isLoading = false;
    }
  }

  /** Renvoie les points dont `time` tombe dans les `count` prochaines heures. */
  nextHours(count: number): ForecastPoint[] {
    const now = Date.now();
    const horizon = now + count * 3600 * 1000;
    return this.points.filter((p) => {
      const t = new Date(p.time).getTime();
      return t >= now && t <= horizon;
    });
  }

  /** Énergie totale (kWh) prévue sur les 24 prochaines heures. */
  get totalEnergyNext24h(): number {
    return this.nextHours(24).reduce((acc, p) => {
      // pvEstimate est en kW, periodSeconds en secondes → kWh.
      return acc + (p.pvEstimate * p.periodSeconds) / 3600;
    }, 0);
  }
}
