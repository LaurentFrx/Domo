/**
 * Store du modèle SHADOW de désirabilité du cumulus (page /cumulus-labo).
 *
 * Lit /api/cumulus/shadow : ce que le modèle continu « aurait » décidé à chaque tick
 * (OBSERVATION SEULE — ne pilote rien). Polling visibility-aware (pattern printer) :
 * pause en arrière-plan + refetch immédiat au retour de visibilité. Le tick moteur
 * est ~65 s → on sonde à 30 s (large marge).
 */

const POLL_MS = 30_000;
const INITIAL_DELAY_MS = 300;

export interface ShadowSample {
  ts: number;
  d: number;
  wouldOn: boolean;
  heatingNow: boolean;
  relayOn: boolean;
  tankRoom: number;
  freeExport: number;
  freeCharge: number;
  freeCurtail: number;
  freeSurplus: number;
  solarWindow: number;
  socPct: number;
  socMinPct: number;
  eAvailWh: number;
  gridPowerW: number;
  reason: string;
}

class CumulusShadowState {
  samples = $state<ShadowSample[]>([]);
  current = $state<ShadowSample | null>(null);
  observationMode = $state(true);
  dOn = $state(0.55);
  dOff = $state(0.35);
  lastTickTs = $state<number | null>(null);
  status = $state<'idle' | 'polling' | 'ok' | 'error'>('idle');
  lastError = $state<string | null>(null);

  /** Nb de ticks « aurait chauffé » dans la fenêtre chargée + minutes estimées. */
  wouldOnCount = $derived(this.samples.filter((s) => s.wouldOn).length);
  /** Pic de D sur la fenêtre chargée. */
  dPeak = $derived(this.samples.reduce((m, s) => Math.max(m, s.d), 0));

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  // Jeton de cycle : incrémenté à chaque (re)démarrage/arrêt. Une chaîne
  // pollAndSchedule dont le jeton n'est plus courant s'arrête au lieu de se
  // ré-armer → aucun timer orphelin si disconnect()/refresh() survient PENDANT un
  // fetch en vol (sinon le poll continuerait toute la session, cassant la pause
  // visibility-aware exigée par CLAUDE.md).
  private cycle = 0;

  connect() {
    if (typeof window === 'undefined' || this.timerId !== null) return;
    const c = ++this.cycle;
    this.timerId = setTimeout(() => this.pollAndSchedule(c), INITIAL_DELAY_MS);
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') this.refresh();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  disconnect() {
    this.cycle++; // invalide toute chaîne en vol
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  async refresh() {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    const c = ++this.cycle; // invalide l'ancienne chaîne, en démarre une neuve
    await this.pollAndSchedule(c);
  }

  private async pollAndSchedule(c: number) {
    await this.poll();
    if (c !== this.cycle) return; // déconnecté ou remplacé pendant le fetch → on s'arrête
    this.timerId = setTimeout(() => this.pollAndSchedule(c), POLL_MS);
  }

  private async poll() {
    this.status = 'polling';
    try {
      const res = await fetch('/api/cumulus/shadow', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        observationMode: boolean;
        dOn: number;
        dOff: number;
        lastTickTs: number | null;
        current: ShadowSample | null;
        samples: ShadowSample[];
      };
      this.samples = data.samples ?? [];
      this.current = data.current ?? null;
      this.observationMode = data.observationMode;
      this.dOn = data.dOn;
      this.dOff = data.dOff;
      this.lastTickTs = data.lastTickTs;
      this.lastError = null;
      this.status = 'ok';
    } catch (e) {
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }
}

export const cumulusShadow = new CumulusShadowState();
