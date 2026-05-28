/**
 * Shelly store — Shelly EM Pro 50 (smart meter réseau) + Shelly 1 Pro (relay
 * cumulus). Polling HTTP local sur le LAN, ou MQTT via broker.
 *
 * Modes :
 *   - 'mock'    : valeurs calculées d'après l'heure
 *   - 'proxy'   : via HA (futur)
 *   - 'direct'  : Shelly HTTP/MQTT local (futur)
 */

import { hourOfDay, solarPV, homeConsumption } from '$utils/mock-curves';

class ShellyState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());

  // ─── Shelly EM Pro 50 — smart meter compteur Linky ───
  gridPowerW = $state(0); // + soutirage, - injection
  gridImportTodayKwh = $state(0);
  gridExportTodayKwh = $state(0);

  // ─── Shelly 1 Pro — relais cumulus ───
  cumulusRelayOn = $state(false);
  cumulusPowerW = $state(0);
  /** Seconds depuis le dernier toggle ON ou OFF. Utilisé pour anti-cycling. */
  cumulusLastToggleSec = $state(0);

  constructor() {
    this.generateMock();
  }

  private generateMock() {
    const h = hourOfDay();
    const pv = solarPV(h);
    const conso = homeConsumption(h);
    const net = conso - pv;
    this.gridPowerW = Math.round(net * 1000);
    this.gridImportTodayKwh = +Math.max(0, h * 0.3 - 2).toFixed(2);
    this.gridExportTodayKwh = +Math.max(0, h * 0.2 - 1).toFixed(2);

    // Cumulus ON entre 11h et 16h (surplus PV) ou 22h-6h (HC)
    const cumulusOn = (h >= 11 && h < 16) || h >= 22 || h < 6;
    this.cumulusRelayOn = cumulusOn;
    this.cumulusPowerW = cumulusOn ? 1850 : 0;
    this.cumulusLastToggleSec = 1200;
  }

  /**
   * Tick périodique du mock — appelé par demo-ticker toutes les 3s.
   * Recalcule depuis l'heure courante + ajoute un jitter modéré pour
   * que les valeurs bougent visuellement (sinon variation imperceptible
   * sur 3s = 3/3600 h).
   */
  tickMock() {
    if (this.mode !== 'mock') return;
    const h = hourOfDay();
    const pv = solarPV(h);
    const conso = homeConsumption(h);
    const jitterKw = (Math.random() - 0.5) * 0.18; // ±90W
    const net = conso - pv + jitterKw;
    this.gridPowerW = Math.round(net * 1000);

    if (this.cumulusRelayOn) {
      this.cumulusPowerW = 1800 + Math.round((Math.random() - 0.5) * 80); // ±40W
    }
    this.cumulusLastToggleSec += 3;
    this.lastUpdate = new Date();
  }

  /** Toggle cumulus — en mode mock c'est instantané. */
  async toggleCumulus() {
    if (this.mode !== 'mock') {
      throw new Error('Shelly direct mode pas encore implémenté');
    }
    this.cumulusRelayOn = !this.cumulusRelayOn;
    this.cumulusPowerW = this.cumulusRelayOn ? 1850 : 0;
    this.cumulusLastToggleSec = 0;
  }
}

export const shelly = new ShellyState();
