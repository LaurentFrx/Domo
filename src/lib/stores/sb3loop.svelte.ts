/**
 * Store de la boucle SB3 — état de la boucle lente d'allocation (tuile
 * /energie) : interrupteur, dernière décision, santé API, journal. Poll 10 s
 * visibility-aware (pattern em50/ankerLocal) ; le TICK tourne côté serveur
 * (timer systemd) — ce store ne fait qu'observer et commander on/off.
 */

interface Sb3Decision {
  ts: number;
  mode: string;
  reason: string;
  houseLoadW: number | null;
  targetW: number | null;
  beforeW: number | null;
  writtenW: number | null;
  confirmedW: number | null;
}

interface Sb3LoopStatus {
  enabled: boolean;
  autoDisabledReason: string | null;
  autoDisabledTs: number | null;
  lastCmdW: number | null;
  lastWriteTs: number | null;
  lastTickTs: number | null;
  confirmFailCount: number;
  decisions: Sb3Decision[];
}

const REFRESH_MS = 10_000;
const TIMEOUT_MS = 9_000;

const EMPTY: Sb3LoopStatus = {
  enabled: false,
  autoDisabledReason: null,
  autoDisabledTs: null,
  lastCmdW: null,
  lastWriteTs: null,
  lastTickTs: null,
  confirmFailCount: 0,
  decisions: []
};

class Sb3LoopState {
  #snap = $state<Sb3LoopStatus>(EMPTY);
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
  get autoDisabledReason(): string | null {
    return this.#snap.autoDisabledReason;
  }
  get lastCmdW(): number | null {
    return this.#snap.lastCmdW;
  }
  get lastWriteTs(): number | null {
    return this.#snap.lastWriteTs;
  }
  get lastTickTs(): number | null {
    return this.#snap.lastTickTs;
  }
  get confirmFailCount(): number {
    return this.#snap.confirmFailCount;
  }
  get decisions(): Sb3Decision[] {
    return this.#snap.decisions;
  }
  /** Dernière décision (tête du ring). */
  get last(): Sb3Decision | null {
    return this.#snap.decisions[0] ?? null;
  }
  /** Le tick tourne-t-il ? (timer systemd vivant : dernier tick < 3 min). */
  get tickAlive(): boolean {
    return this.#snap.lastTickTs !== null && Date.now() - this.#snap.lastTickTs < 180_000;
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
      const res = await fetch('/api/sb3loop/status', { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.#snap = { ...EMPTY, ...((await res.json()) as Sb3LoopStatus) };
      this.#ok = true;
    } catch {
      this.#ok = false;
    }
  }

  /** Interrupteur de la tuile — optimiste avec resynchronisation. */
  async setEnabled(enabled: boolean) {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch('/api/sb3loop/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) await this.poll();
    } finally {
      this.busy = false;
    }
  }
}

export const sb3loop = new Sb3LoopState();
