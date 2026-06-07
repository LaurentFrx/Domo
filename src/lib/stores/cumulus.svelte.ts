/**
 * Cumulus store — orchestrateur ECS.
 *
 * Logique métier : choisir l'état du relais Shelly cumulus selon mode, surplus
 * PV, tarif HC en cours, contraintes ANSES (anti-légionellose ≥60°C/7j), et
 * pièges (anti-cycling, fighting SB3).
 *
 * Pour l'instant, en mode mock : on lit la température "actuelle" et on expose
 * les paramètres de config. Les actions se traduisent en appel shelly.toggle()
 * dans une phase ultérieure.
 *
 * Modes :
 *   - 'mock'    : valeurs simulées
 *   - 'proxy'   : via HA (futur)
 *   - 'direct'  : Node/TS sur RPi4 (futur)
 */

import type { CumulusMode } from '$theme/tokens';
import { hourOfDay, cumulusTemp } from '$utils/mock-curves';
import { zigbee } from './zigbee.svelte';

class CumulusState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());

  // ─── État ───────────────────────────────────────
  /** Mode courant. */
  currentMode = $state<CumulusMode>('PV');
  /** Température mock interne (placeholder avant/sans sonde réelle). */
  #mockTempC = $state(0);
  /**
   * Température mesurée (°C) — RÉELLE depuis la sonde Zigbee `thermo_cumulus`
   * (SNZB-02LD) si elle remonte, sinon repli sur le mock. La sonde est sur le
   * réseau Zigbee (store zigbee, connecté sur /climat & /pieces).
   */
  temperatureC = $derived.by(() => {
    const d = zigbee.devices.find((x) => x.friendlyName === 'thermo_cumulus');
    const t = d?.state?.temperature;
    return typeof t === 'number' ? +t.toFixed(1) : this.#mockTempC;
  });
  /** Tendance (°C/h, + = chauffe, - = refroidit). */
  trendCh = $state(0);
  /** Énergie injectée aujourd'hui (kWh). */
  energyTodayKwh = $state(0);
  /** Besoin estimé journée (kWh). */
  energyTargetKwh = $state(8);
  /** Date du prochain cycle anti-légionellose obligatoire. */
  nextLegionnellaCycle = $state<Date>(new Date(Date.now() + 4 * 24 * 3600 * 1000));

  // ─── Relais Shelly Pro 1 (RÉEL, via /api/cumulus/relay) ──────────
  /** État du relais cumulus : true = chauffe, false = arrêté, null = inconnu. */
  relayOn = $state<boolean | null>(null);
  /** Le boîtier Shelly répond-il ? (alimente la section Connexions). */
  relayConnected = $state(false);
  /** Température interne du boîtier (°C) — diagnostic. */
  relayTempC = $state<number | null>(null);
  #relayTimer: ReturnType<typeof setInterval> | null = null;
  #relayVis: (() => void) | null = null;

  // ─── Configuration (modifiable via /reglages) ────
  /** Seuil surplus PV pour ON (W). */
  surplusOnThreshold = $state(1500);
  /** Seuil surplus PV pour OFF (W). */
  surplusOffThreshold = $state(200);
  /** Durée minimale ON (sec). */
  minOnDurationSec = $state(300);
  /** Délai anti-cycling (sec). */
  antiCyclingSec = $state(600);
  /** Température cible (°C). */
  targetTempC = $state(62);
  /** Température max sécurité (°C). */
  maxTempC = $state(75);
  /** Plage HC : début (h décimal — 0.1 = 00:06). Fenêtre RÉELLE 00:06–08:06. */
  hcStartHour = $state(0.1);
  /** Plage HC : fin (h décimal — 8.1 = 08:06). */
  hcEndHour = $state(8.1);

  constructor() {
    this.generateMock();
  }

  private generateMock() {
    const h = hourOfDay();
    this.#mockTempC = +cumulusTemp(h).toFixed(1);
    // Tendance : dérivée numérique
    const next = cumulusTemp(h + 0.1);
    this.trendCh = +((next - this.#mockTempC) * 10).toFixed(1);
    this.energyTodayKwh = +(Math.max(0, h - 6) * 0.55).toFixed(2);
    this.currentMode =
      h >= 11 && h < 16 ? 'PV' : h >= this.hcStartHour && h < this.hcEndHour ? 'HC' : 'OFF';
  }

  /**
   * Tick périodique du mock — appelé par demo-ticker toutes les 3s.
   * Petit jitter ±0.15°C autour de la courbe théorique pour montrer
   * la mesure capteur "qui frémit". Le mode auto reste figé (pas de
   * basculement aléatoire).
   */
  tickMock() {
    if (this.mode !== 'mock') return;
    const h = hourOfDay();
    const base = cumulusTemp(h);
    const jitter = (Math.random() - 0.5) * 0.3; // ±0.15°C
    this.#mockTempC = +(base + jitter).toFixed(1);
    const next = cumulusTemp(h + 0.1);
    this.trendCh = +((next - base) * 10).toFixed(1);
    this.lastUpdate = new Date();
  }

  /** Pourcentage progression vs cible (0-100). Garde anti-division par zéro. */
  progressPercent = $derived(
    this.targetTempC > 0
      ? Math.min(100, Math.round((this.temperatureC / this.targetTempC) * 100))
      : 0
  );

  /** Coût horaire (€) si ON. */
  costPerHour = $derived(
    1.85 * (this.currentMode === 'HC' ? 0.1812 : this.currentMode === 'OFF' ? 0 : 0.2318)
  );

  setMode(mode: CumulusMode) {
    this.currentMode = mode;
  }

  // ─── Relais réel (Shelly Pro 1) ─────────────────
  /** Lecture de l'état du relais. Marque relayConnected selon la réponse. */
  async refreshRelay() {
    try {
      const res = await fetch('/api/cumulus/relay', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      this.relayOn = typeof d.on === 'boolean' ? d.on : null;
      this.relayTempC = typeof d.tC === 'number' ? d.tC : null;
      this.relayConnected = true;
      this.lastUpdate = new Date();
    } catch {
      this.relayConnected = false;
    }
  }

  /** Démarre le polling du relais (10 s, visibility-aware). Idempotent. */
  connectRelay() {
    if (this.#relayTimer || typeof document === 'undefined') return;
    this.refreshRelay();
    this.#relayTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refreshRelay();
    }, 10_000);
    this.#relayVis = () => {
      if (document.visibilityState === 'visible') this.refreshRelay();
    };
    document.addEventListener('visibilitychange', this.#relayVis);
  }

  disconnectRelay() {
    if (this.#relayTimer) {
      clearInterval(this.#relayTimer);
      this.#relayTimer = null;
    }
    if (this.#relayVis) {
      document.removeEventListener('visibilitychange', this.#relayVis);
      this.#relayVis = null;
    }
  }

  /** Allume/éteint le cumulus (Shelly). Optimiste, puis confirmé par relecture. */
  async setRelay(on: boolean) {
    this.relayOn = on; // reflet optimiste immédiat
    try {
      const res = await fetch('/api/cumulus/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      this.relayOn = typeof d.on === 'boolean' ? d.on : on;
      this.relayConnected = true;
    } catch {
      this.refreshRelay(); // resync sur échec
    }
  }
}

export const cumulus = new CumulusState();
