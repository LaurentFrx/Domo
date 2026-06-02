/**
 * Store prévision PV — source Open-Meteo + PVLib via forecast-bridge (RPi4),
 * proxifié server-side par /api/forecast. Calqué sur le pattern airzone.
 *
 * Estimation DÉTERMINISTE (pas de P10/P90). Les puissances sont le POTENTIEL
 * écrêté onduleur/SB, pas la prod livrée/autoconsommée. Calage empirique en
 * juillet (EM50 + Solarbank Max).
 */

/** Point exposé au front (kW). */
export interface PvForecastPoint {
  time: string; // ISO local (Europe/Paris), ex. "2026-06-02T13:00"
  kw: number; // total écrêté (kW)
  kwSud: number; // sous-champ sud 190° (kW)
  kwOuest: number; // sous-champ ouest 280° (kW)
}

// ─── Contrat du bridge (/api/forecast, confirmé étape 0) ────────────────
interface BridgePowerW {
  paths?: Record<string, number>;
  sud: number;
  ouest: number;
  total: number;
}
interface BridgeHourly {
  time: string;
  power_w?: BridgePowerW;
}
interface BridgeForecast {
  model?: string | null;
  last_update?: string | null;
  fresh?: boolean;
  count?: number;
  next_24h_kwh?: number;
  hourly?: BridgeHourly[];
}

const REFRESH_MS = 300_000; // 5 min — le bridge ne rafraîchit Open-Meteo que toutes les 30 min
const TIMEOUT_MS = 14_000;

class ForecastState {
  points = $state<PvForecastPoint[]>([]);
  next24hKwh = $state(0);
  fetchedAt = $state<string | null>(null);
  model = $state<string | null>(null);
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
      const res = await fetch('/api/forecast', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BridgeForecast;

      // Forme réelle du bridge (confirmée étape 0) : tableau `hourly`, temps
      // `time`, puissances en W sous `power_w.{total,sud,ouest}`.
      const raw = Array.isArray(data.hourly) ? data.hourly : [];
      this.points = raw.map((p) => ({
        time: p.time,
        kw: (p.power_w?.total ?? 0) / 1000,
        kwSud: (p.power_w?.sud ?? 0) / 1000,
        kwOuest: (p.power_w?.ouest ?? 0) / 1000
      }));
      this.next24hKwh = data.next_24h_kwh ?? 0;
      this.fetchedAt = data.last_update ?? null;
      this.model = data.model ?? null;
      this.status = 'live';
      this.lastError = null;
    } catch (e) {
      // on garde le dernier état connu ; on signale juste l'erreur
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'erreur inconnue';
    }
  }
}

export const forecast = new ForecastState();
