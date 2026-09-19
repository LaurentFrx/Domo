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
 *
 * Niveaux affichés EN PERMANENCE (19/09/2026) : le dernier relevé vu, sans date.
 * L'imprimante est le plus souvent hors tension, et l'encre ne bouge que quand
 * elle imprime — le dernier relevé est donc le niveau courant. Deux mémoires :
 * le cache du navigateur (affichage instantané, SANS expiration désormais) et
 * celle du serveur (`?cached=1`, lue au montage) — la seule qui survive à un
 * nouvel appareil ou à Safari qui purge une PWA restée une semaine fermée.
 */

const SUCCESS_INTERVAL_MS = 5 * 60 * 1000;
const ERROR_INTERVAL_MS = 30 * 1000;
const INITIAL_DELAY_MS = 500;
const CACHE_KEY = 'domo.printer.cache.v1';

export type InkColor = 'BK' | 'C' | 'M' | 'Y';
export interface InkTank {
  color: InkColor;
  label: string;
  percent: number;
}

function loadCachedInks(): InkTank[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as { inks?: InkTank[] }).inks ?? [];
  } catch {
    return [];
  }
}

function saveCachedInks(inks: InkTank[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ inks }));
  } catch {
    // ignore
  }
}

class PrinterState {
  /** Niveaux d'encre — le dernier relevé vu, gardé MÊME quand l'imprimante est
   * hors tension. Source : relevé en direct, sinon mémoire serveur, sinon cache
   * du navigateur (au montage). */
  inks = $state<InkTank[]>(loadCachedInks());
  /** true si la dernière requête a réussi. Indépendant des niveaux d'encre :
   * on garde les valeurs cached même si online=false (imprimante éteinte). */
  online = $state(false);
  lastError = $state<string | null>(null);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');

  empty = $derived(this.inks.length === 0);

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  /** Un relevé en direct est arrivé : la mémoire serveur ne doit plus l'écraser. */
  private gotLive = false;

  connect() {
    if (typeof window === 'undefined') return;
    if (this.timerId !== null) return;
    // Mémoire serveur d'abord : réponse immédiate, sans attendre l'échec réseau
    // (~3-5 s) d'une imprimante hors tension.
    void this.loadServerMemory();
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

  private async loadServerMemory() {
    try {
      const res = await fetch('/api/printer/status?cached=1', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { inks?: InkTank[] };
      if (!this.gotLive && data.inks && data.inks.length > 0) {
        this.inks = data.inks;
        saveCachedInks(data.inks);
      }
    } catch {
      // Sans mémoire serveur, le cache du navigateur et le poll prennent le relais.
    }
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
        if (data.online) this.gotLive = true;
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
