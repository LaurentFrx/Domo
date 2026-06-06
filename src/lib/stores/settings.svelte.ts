/**
 * Settings store — valeurs métier partagées **cross-device** via le serveur.
 *
 * Sync via GET/PUT /api/settings (fichier JSON côté Node, voir
 * lib/server/settings-store.ts).
 *
 * À distinguer de `preferences.svelte.ts` qui reste en localStorage
 * (préférences UI per-device : theme, animations, unité d'affichage).
 */

type Persisted = {
  priceHc: number;
  priceHp: number;
  priceExport: number;
  subscription: number;
  /** Coût total de l'installation PV+batterie (€) — sert au calcul du ROI. */
  installationCostEur: number;
  /** Date de mise en service 'YYYY-MM-DD' — sert au taux d'économie annuel réalisé. */
  installationDateISO: string;
};

const DEFAULTS: Persisted = {
  priceHc: 0.1812,
  priceHp: 0.2318,
  priceExport: 0.04,
  subscription: 13.5,
  installationCostEur: 4500,
  installationDateISO: '2025-06-01'
};

class SettingsState {
  priceHc = $state(DEFAULTS.priceHc);
  priceHp = $state(DEFAULTS.priceHp);
  priceExport = $state(DEFAULTS.priceExport);
  subscription = $state(DEFAULTS.subscription);
  installationCostEur = $state(DEFAULTS.installationCostEur);
  installationDateISO = $state(DEFAULTS.installationDateISO);

  /** true pendant le fetch initial — évite de save pendant hydrate. */
  hydrating = $state(false);
  /** true pendant un save en cours. Affichable dans l'UI si besoin. */
  saving = $state(false);
  /** Dernière erreur réseau (null si OK). */
  lastError = $state<string | null>(null);

  async hydrate() {
    if (typeof window === 'undefined') return;
    this.hydrating = true;
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Partial<Persisted>;
      if (typeof data.priceHc === 'number') this.priceHc = data.priceHc;
      if (typeof data.priceHp === 'number') this.priceHp = data.priceHp;
      if (typeof data.priceExport === 'number') this.priceExport = data.priceExport;
      if (typeof data.subscription === 'number') this.subscription = data.subscription;
      if (typeof data.installationCostEur === 'number')
        this.installationCostEur = data.installationCostEur;
      if (typeof data.installationDateISO === 'string' && data.installationDateISO)
        this.installationDateISO = data.installationDateISO;
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.hydrating = false;
    }
  }

  async save() {
    if (typeof window === 'undefined') return;
    if (this.hydrating) return;
    this.saving = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceHc: this.priceHc,
          priceHp: this.priceHp,
          priceExport: this.priceExport,
          subscription: this.subscription,
          installationCostEur: this.installationCostEur,
          installationDateISO: this.installationDateISO
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.saving = false;
    }
  }
}

export const settings = new SettingsState();
