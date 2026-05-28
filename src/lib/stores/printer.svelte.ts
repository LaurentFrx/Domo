/**
 * Printer store — niveaux d'encre de l'Imprimante Epson, scrapés
 * serveur-side via /api/printer/status.
 *
 * Polling adaptatif :
 *   - Succès      → 5 min  (l'encre évolue lentement)
 *   - Erreur      → 30 s   (back-off court, imprimante peut redémarrer)
 *   - Non configuré → pas de re-poll automatique (re-tente au refresh manuel)
 *
 * Et re-poll si :
 *   - L'onglet redevient visible (visibilitychange)
 *   - Refresh manuel via printer.refresh()
 */

const SUCCESS_INTERVAL_MS = 5 * 60 * 1000;
const ERROR_INTERVAL_MS = 30 * 1000;
const INITIAL_DELAY_MS = 500;
const CACHE_KEY = 'domo.printer.cache.v1';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours — encre évolue lentement

export type InkColor = 'BK' | 'C' | 'M' | 'Y';
export interface InkTank {
  color: InkColor;
  label: string;
  percent: number;
}

function loadCachedInks(): { inks: InkTank[]; ts: number | null } {
  if (typeof window === 'undefined') return { inks: [], ts: null };
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { inks: [], ts: null };
    const parsed = JSON.parse(raw) as { ts: number; inks: InkTank[] };
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) return { inks: [], ts: null };
    return { inks: parsed.inks ?? [], ts: parsed.ts };
  } catch {
    return { inks: [], ts: null };
  }
}

function saveCachedInks(inks: InkTank[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), inks }));
  } catch {
    // ignore
  }
}

class PrinterState {
  private initial = loadCachedInks();
  /** Niveaux d'encre — gardés MÊME quand l'imprimante est offline.
   * Source : dernier scrape réussi, ou cache localStorage au mount. */
  inks = $state<InkTank[]>(this.initial.inks);
  /** Date du dernier scrape réussi (peut venir du cache). */
  lastUpdate = $state<Date | null>(this.initial.ts ? new Date(this.initial.ts) : null);
  /** true si la dernière requête a réussi. Indépendant des niveaux d'encre :
   * on garde les valeurs cached même si online=false (imprimante éteinte). */
  online = $state(false);
  lastError = $state<string | null>(null);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');

  empty = $derived(this.inks.length === 0);

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;

  connect() {
    if (typeof window === 'undefined') return;
    if (this.timerId !== null) return;
    // 1er poll rapide
    this.timerId = setTimeout(() => this.pollAndSchedule(), INITIAL_DELAY_MS);
    // Re-poll quand l'onglet redevient actif
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.refresh();
      }
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

  /** Force un poll immédiat (bouton refresh manuel, onglet réactivé, etc.). */
  async refresh() {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    await this.pollAndSchedule();
  }

  private async pollAndSchedule() {
    await this.poll();
    // Re-planifie le prochain poll selon le statut.
    if (this.status === 'unconfigured') return; // inutile de reboucler
    const delay = this.status === 'connected' ? SUCCESS_INTERVAL_MS : ERROR_INTERVAL_MS;
    this.timerId = setTimeout(() => this.pollAndSchedule(), delay);
  }

  private async poll() {
    this.status = 'polling';
    try {
      const res = await fetch('/api/printer/status', { cache: 'no-store' });
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
      // ⚠ Ne JAMAIS écraser inks par [] : on garde les dernières valeurs connues
      // pour que la carte reste utile quand l'imprimante est éteinte.
      if (data.inks && data.inks.length > 0) {
        this.inks = data.inks;
        saveCachedInks(data.inks);
        this.lastUpdate = new Date();
      }
      this.lastError = data.error ?? null;
      this.status = data.error || !data.online ? 'error' : 'connected';
    } catch (e) {
      this.online = false;
      this.status = 'error';
      this.lastError = (e as Error).message;
      // Idem : on ne touche pas à `inks`, l'utilisateur garde la dernière vue.
    }
  }
}

export const printer = new PrinterState();
