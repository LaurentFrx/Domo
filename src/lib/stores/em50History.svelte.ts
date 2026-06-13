/**
 * Store historique EM-50 — réseau réel signé + conso cumulus sur 24 h, plus les
 * totaux du jour (import / export réseau + conso cumulus, kWh). Source
 * `/api/em50/history` (domo-recorder via better-sqlite3). Calqué STRICTEMENT sur
 * productionHistory : poll d'une route relative, garde le dernier état connu,
 * connect/disconnect.
 *
 * Cadence 2 min (le recorder tique plus souvent, mais une courbe 24 h n'a pas
 * besoin de plus). Erreur → on garde le dernier état (jamais de crash) ; réponse
 * vide → points: [] et today à 0.
 */
export interface Em50Point {
  ts: number; // epoch UTC (s)
  em50_grid_w: number | null; // + soutirage EDF / − injection (W)
  em50_cumulus_w: number | null; // conso cumulus (W)
}

export interface Em50Today {
  import_kwh: number;
  export_kwh: number;
  cumulus_kwh: number;
}

const HOURS = 24;
const REFRESH_MS = 120_000; // 2 min
const TIMEOUT_MS = 14_000;

const EMPTY_TODAY: Em50Today = { import_kwh: 0, export_kwh: 0, cumulus_kwh: 0 };

class Em50HistoryState {
  points = $state<Em50Point[]>([]);
  today = $state<Em50Today>(EMPTY_TODAY);
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
      const res = await fetch(`/api/em50/history?hours=${HOURS}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { points?: Em50Point[]; today?: Em50Today };
      this.points = Array.isArray(data.points) ? data.points : [];
      this.today = data.today ?? EMPTY_TODAY;
      this.status = 'live';
      this.lastError = null;
    } catch (e) {
      // On garde le dernier état connu ; on ne fait que signaler l'erreur.
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'erreur inconnue';
    }
  }
}

export const em50History = new Em50HistoryState();
