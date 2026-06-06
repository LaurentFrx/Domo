/**
 * Store tarif HP/HC RÉEL — lit /api/tariffs/current (vraie logique serveur,
 * source data/tariffs.json). Remplace le mock `mock-curves` (fenêtre HC fausse).
 *
 * Le tarif ne change qu'aux bornes de fenêtre (2×/jour) → polling lent (5 min)
 * suffit, + refetch immédiat au retour de visibilité (PWA rouverte) pour ne pas
 * afficher une bascule périmée. Robuste : erreur réseau → on garde le dernier état.
 */

const REFRESH_MS = 5 * 60 * 1000;

interface TariffPayload {
  period: 'HP' | 'HC';
  price_eur_kwh: number;
  next: { period: 'HP' | 'HC'; at: string; in_minutes: number };
}

const EMPTY: TariffPayload = {
  period: 'HP',
  price_eur_kwh: 0,
  next: { period: 'HC', at: '', in_minutes: 0 }
};

class TariffState {
  #snap = $state<TariffPayload>(EMPTY);
  status = $state<'idle' | 'live' | 'error'>('idle');

  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  /** Période en cours ('HP' | 'HC'). */
  get period(): 'HP' | 'HC' {
    return this.#snap.period;
  }
  /** Prix du kWh en cours (€). */
  get priceEurKwh(): number {
    return this.#snap.price_eur_kwh;
  }
  /** Prochaine bascule : période visée, heure locale 'HH:MM', délai (min). */
  get next(): { period: 'HP' | 'HC'; at: string; in_minutes: number } {
    return this.#snap.next;
  }
  /** Délai jusqu'à la bascule, arrondi en heures (≥ 1). */
  get nextInHours(): number {
    return Math.max(1, Math.round(this.#snap.next.in_minutes / 60));
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.#visibilityHandler !== null) return; // idempotent
    this.#visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.#start();
      } else {
        this.#stop();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
    this.poll();
    this.#start();
  }

  disconnect() {
    this.#stop();
    if (this.#visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
  }

  #start() {
    this.#timer ??= setInterval(() => this.poll(), REFRESH_MS);
  }

  #stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async poll() {
    try {
      const res = await fetch('/api/tariffs/current', { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as TariffPayload;
      this.#snap = {
        period: p.period === 'HC' ? 'HC' : 'HP',
        price_eur_kwh: Number(p.price_eur_kwh) || 0,
        next: {
          period: p.next?.period === 'HC' ? 'HC' : 'HP',
          at: String(p.next?.at ?? ''),
          in_minutes: Number(p.next?.in_minutes) || 0
        }
      };
      this.status = 'live';
    } catch {
      this.status = 'error'; // on garde le dernier état connu
    }
  }
}

export const tariff = new TariffState();
