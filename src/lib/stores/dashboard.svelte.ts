/**
 * Store dashboard — état global de l'app (Svelte 5 Runes).
 *
 * Phase 1 : données mockées.
 * Phase 1.4 : alimenté par le HA WebSocket client.
 */

import type { CumulusMode } from '$theme/tokens';

class DashboardState {
  // ─── Cumulus ───
  cumulusTemp = $state(62);
  cumulusTempTrend = $state(4); // °C / heure
  cumulusMode = $state<CumulusMode>('PV');
  cumulusPower = $state(1850); // W
  cumulusGaugePercent = $state(72);
  cumulusCostHour = $state(0.0); // €

  // ─── Solaire ───
  solarPower = $state(2.17); // kW
  solarSelfConsumption = $state(84); // %
  solarSurplus = $state(320); // W
  solarProduction24h = $state([
    0.12, 0.18, 0.35, 0.55, 0.78, 0.92, 1.0, 0.88, 0.65, 0.42, 0.22, 0.08
  ]);
  solarTotal24h = $state(18.4); // kWh

  // ─── Batterie ───
  batteryLevel = $state(87); // %
  batteryStatus = $state<'charge' | 'discharge' | 'idle'>('charge');

  // ─── Connexion HA ───
  connectionStatus = $state<'connected' | 'connecting' | 'disconnected' | 'mock'>('mock');
  lastUpdate = $state<Date | null>(new Date());

  setCumulusMode(mode: CumulusMode) {
    this.cumulusMode = mode;
    // TODO Phase 1.4 : appel service HA input_select.select_option
  }
}

export const dashboard = new DashboardState();
