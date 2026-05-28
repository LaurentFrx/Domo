/**
 * Printer store — niveaux d'encre de l'Imprimante Epson Workforce,
 * scrapés serveur-side via /api/printer/status.
 *
 * Polling 10 min : les niveaux d'encre évoluent lentement, pas besoin
 * de marteler l'imprimante.
 */

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_DELAY_MS = 2000;

export type InkColor = 'BK' | 'C' | 'M' | 'Y';
export interface InkTank {
  color: InkColor;
  label: string;
  percent: number;
}

class PrinterState {
  inks = $state<InkTank[]>([]);
  online = $state(false);
  lastUpdate = $state<Date | null>(null);
  lastError = $state<string | null>(null);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');

  /** true tant qu'on n'a aucune donnée affichable. */
  empty = $derived(this.inks.length === 0);

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  connect() {
    if (typeof window === 'undefined') return;
    if (this.intervalId !== null) return;
    // léger délai pour ne pas spammer au mount
    this.initialTimer = setTimeout(() => {
      this.poll();
      this.intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
  }

  disconnect() {
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll() {
    this.status = 'polling';
    try {
      const res = await fetch('/api/printer/status');
      if (res.status === 503) {
        this.status = 'unconfigured';
        this.online = false;
        this.lastError = 'PRINTER_HOST non défini côté serveur';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        online: boolean;
        inks: InkTank[];
        error?: string;
      };
      this.online = data.online;
      this.inks = data.inks ?? [];
      this.lastError = data.error ?? null;
      this.status = data.error ? 'error' : 'connected';
      this.lastUpdate = new Date();
    } catch (e) {
      this.online = false;
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }
}

export const printer = new PrinterState();
