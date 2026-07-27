/**
 * Store de la boucle de bridage APS — état lu par la tuile /energie :
 * interrupteur, mode d'observation, dernière photo du tick, journal des
 * décisions. Poll 10 s visibility-aware (pattern sb3loop) ; le TICK tourne
 * côté serveur (timer systemd) — ce store ne fait qu'observer et commander.
 */

interface ApsDecision {
  ts: number;
  mode: string;
  writtenW: number | null;
  confirmedW: number | null;
  gridW: number;
  apsW: number;
  maxW: number;
  reason: string;
}

interface ApsObservation {
  ts: number;
  gridW: number;
  apsW: number;
  capW: number;
  maxLimitW: number;
  apsAvailable: boolean;
  em50Available: boolean;
}

interface ApsLoopStatus {
  enabled: boolean;
  observationMode: boolean;
  lastObs: ApsObservation | null;
  autoDisabledReason: string | null;
  confirmFailCount: number;
  lastTickTs: number | null;
  lastWriteTs: number | null;
  lastCmdW: number | null;
  log: ApsDecision[];
}

const REFRESH_MS = 10_000;
const TIMEOUT_MS = 9_000;

const EMPTY: ApsLoopStatus = {
  enabled: false,
  observationMode: true,
  lastObs: null,
  autoDisabledReason: null,
  confirmFailCount: 0,
  lastTickTs: null,
  lastWriteTs: null,
  lastCmdW: null,
  log: []
};

class ApsLoopState {
  #snap = $state<ApsLoopStatus>(EMPTY);
  #ok = $state(false);
  busy = $state(false);

  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  get connected(): boolean {
    return this.#ok;
  }
  get enabled(): boolean {
    return this.#snap.enabled;
  }
  get observationMode(): boolean {
    return this.#snap.observationMode;
  }
  get obs(): ApsObservation | null {
    return this.#snap.lastObs;
  }
  get autoDisabledReason(): string | null {
    return this.#snap.autoDisabledReason;
  }
  get confirmFailCount(): number {
    return this.#snap.confirmFailCount;
  }
  get lastCmdW(): number | null {
    return this.#snap.lastCmdW;
  }
  get lastWriteTs(): number | null {
    return this.#snap.lastWriteTs;
  }
  /** Journal du plus récent au plus ancien (le serveur empile en fin de tableau). */
  get decisions(): ApsDecision[] {
    return [...this.#snap.log].reverse();
  }
  get last(): ApsDecision | null {
    return this.decisions[0] ?? null;
  }
  /** Le tick tourne-t-il ? (timer systemd vivant : dernier tick < 3 min). */
  get tickAlive(): boolean {
    return this.#snap.lastTickTs !== null && Date.now() - this.#snap.lastTickTs < 180_000;
  }
  /** L'onduleur est-il effectivement bridé en ce moment ? */
  get throttled(): boolean {
    const o = this.#snap.lastObs;
    return !!o && o.capW < o.maxLimitW;
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.#visibilityHandler !== null) return;
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
      const res = await fetch('/api/apsloop/status', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.#snap = { ...EMPTY, ...((await res.json()) as ApsLoopStatus) };
      this.#ok = true;
    } catch {
      this.#ok = false;
    }
  }

  async #command(body: Record<string, boolean>) {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch('/api/apsloop/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) await this.poll();
    } finally {
      this.busy = false;
    }
  }

  setEnabled(enabled: boolean) {
    return this.#command({ enabled });
  }
  /** Observation = journalise sans commander l'onduleur. */
  setObservation(observation: boolean) {
    return this.#command({ observationMode: observation });
  }
}

export const apsloop = new ApsLoopState();
