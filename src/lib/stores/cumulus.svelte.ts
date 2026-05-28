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

class CumulusState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());

  // ─── État ───────────────────────────────────────
  /** Mode courant. */
  currentMode = $state<CumulusMode>('PV');
  /** Température mesurée (°C). */
  temperatureC = $state(0);
  /** Tendance (°C/h, + = chauffe, - = refroidit). */
  trendCh = $state(0);
  /** Énergie injectée aujourd'hui (kWh). */
  energyTodayKwh = $state(0);
  /** Besoin estimé journée (kWh). */
  energyTargetKwh = $state(8);
  /** Date du prochain cycle anti-légionellose obligatoire. */
  nextLegionnellaCycle = $state<Date>(new Date(Date.now() + 4 * 24 * 3600 * 1000));

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
  /** Plage HC : début (h, 0-24). */
  hcStartHour = $state(22);
  /** Plage HC : fin (h, 0-24). */
  hcEndHour = $state(6);

  constructor() {
    this.generateMock();
  }

  private generateMock() {
    const h = hourOfDay();
    this.temperatureC = +cumulusTemp(h).toFixed(1);
    // Tendance : dérivée numérique
    const next = cumulusTemp(h + 0.1);
    this.trendCh = +((next - this.temperatureC) * 10).toFixed(1);
    this.energyTodayKwh = +(Math.max(0, h - 6) * 0.55).toFixed(2);
    this.currentMode = h >= 11 && h < 16 ? 'PV' : h >= 22 || h < 6 ? 'HC' : 'OFF';
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
    this.temperatureC = +(base + jitter).toFixed(1);
    const next = cumulusTemp(h + 0.1);
    this.trendCh = +((next - base) * 10).toFixed(1);
    this.lastUpdate = new Date();
  }

  /** Pourcentage progression vs cible (0-100). */
  progressPercent = $derived(
    Math.min(100, Math.round((this.temperatureC / this.targetTempC) * 100))
  );

  /** Coût horaire (€) si ON. */
  costPerHour = $derived(
    1.85 * (this.currentMode === 'HC' ? 0.1812 : this.currentMode === 'OFF' ? 0 : 0.2318)
  );

  setMode(mode: CumulusMode) {
    this.currentMode = mode;
  }
}

export const cumulus = new CumulusState();
