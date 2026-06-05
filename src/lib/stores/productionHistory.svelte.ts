/**
 * Store historique de production PV — série réelle pour la courbe de la Section 1
 * (page Énergie). Source : `/api/production/history` (domo-recorder via
 * better-sqlite3). Calqué sur le cycle de vie de `forecast` : poll d'une route
 * relative, garde le dernier état connu, connect/disconnect.
 *
 * Cadence 2 min = celle du recorder (inutile plus souvent). Erreur → on garde le
 * dernier état (jamais de crash) ; réponse vide → `points: []`.
 */
export interface ProductionPoint {
  ts: number; // epoch UTC (s)
  production_w: number;
  aps_w: number;
  sb_w: number;
}

const HOURS = 24;
const REFRESH_MS = 120_000; // 2 min, cadence du recorder
const TIMEOUT_MS = 14_000;

class ProductionHistoryState {
  points = $state<ProductionPoint[]>([]);
  status = $state<'idle' | 'live' | 'error'>('idle');
  lastError = $state<string | null>(null);

  #timer: ReturnType<typeof setInterval> | null = null;

  connect() {
    if (typeof window === 'undefined') return; // pas de poll en SSR
    this.poll();
    this.#timer ??= setInterval(() => this.poll(), REFRESH_MS);
  }

  disconnect() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async poll() {
    try {
      const res = await fetch(`/api/production/history?hours=${HOURS}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { points?: ProductionPoint[] };
      // Réponse vide ou mal formée → tableau vide (la courbe gère l'état « en attente »).
      this.points = Array.isArray(data.points) ? data.points : [];
      this.status = 'live';
      this.lastError = null;
    } catch (e) {
      // On garde le dernier état connu ; on ne fait que signaler l'erreur.
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'erreur inconnue';
    }
  }
}

export const productionHistory = new ProductionHistoryState();
