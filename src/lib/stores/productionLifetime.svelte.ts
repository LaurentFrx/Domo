/**
 * Production lifetime FIABLE (carte « Production totale » de l'accueil).
 *
 * Lit /api/production/lifetime = MAX des compteurs matériels historisés par le
 * recorder (APS EZ1 + SolarBank), robuste au bug cloud « daily-as-lifetime » du
 * 22/07. Le lifetime évolue lentement → poll 10 min, visibility-aware.
 */

const POLL_MS = 10 * 60 * 1000;
const INITIAL_DELAY_MS = 400;

class ProductionLifetimeState {
  totalKwh = $state(0);
  apsKwh = $state(0);
  ankerKwh = $state(0);
  available = $state(false);

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;

  connect() {
    if (typeof window === 'undefined') return;
    if (this.timerId !== null) return;
    this.timerId = setTimeout(() => this.pollAndSchedule(), INITIAL_DELAY_MS);
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') this.refresh();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  disconnect() {
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
    await this.pollAndSchedule();
  }

  private async pollAndSchedule() {
    await this.poll();
    this.timerId = setTimeout(() => this.pollAndSchedule(), POLL_MS);
  }

  private async poll() {
    try {
      const res = await fetch('/api/production/lifetime', { cache: 'no-store' });
      if (!res.ok) return; // 503 (DB indispo) → on garde la dernière valeur connue
      const d = (await res.json()) as {
        available: boolean;
        apsKwh: number;
        ankerKwh: number;
        totalKwh: number;
      };
      if (d.available && d.totalKwh > 0) {
        this.totalKwh = d.totalKwh;
        this.apsKwh = d.apsKwh;
        this.ankerKwh = d.ankerKwh;
        this.available = true;
      }
    } catch {
      // réseau : on conserve la dernière valeur connue
    }
  }
}

export const productionLifetime = new ProductionLifetimeState();
