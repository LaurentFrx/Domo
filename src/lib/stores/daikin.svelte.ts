/**
 * Daikin store — climatisation Onecta cloud.
 *
 * Modes :
 *   - 'mock'    : valeurs réalistes
 *   - 'proxy'   : via HA (futur, sera supprimé)
 *   - 'direct'  : python-daikin-onecta sur RPi4 (cible — OAuth Daikin
 *                 + polling périodique, exposé via Caddy comme anker-bridge)
 *
 * Périmètre Domo (décisions Laurent 2026-05-28) :
 *   on garde : operationMode (heating/cooling/off), onOff, outdoor
 *              temperature, consigne par mode, fan speed (auto/quiet/
 *              level1..5), swing horizontal/vertical, statut connexion.
 *   ailleurs : conso → /energie ; ambiante + humidité → thermo Zigbee
 *              de la pièce (pas l'unité Daikin).
 */

export type DaikinOperationMode = 'heating' | 'cooling' | 'off';
export type FanSpeed = 'auto' | 'quiet' | 'level1' | 'level2' | 'level3' | 'level4' | 'level5';
export type SwingMode = 'off' | 'swing';

export type DaikinUnit = {
  id: string;
  name: string;
  zone: string;
  /** Connexion à l'unité (cloud Onecta accessible). */
  online: boolean;
  /** Alimentation. Indépendant du operationMode. */
  onOff: boolean;
  /** Mode opérationnel. */
  operationMode: DaikinOperationMode;
  /** Température extérieure mesurée par l'unité ext (°C). */
  outdoorTempC: number;
  /** Consigne en mode chaud (°C). */
  targetHeating: number;
  /** Consigne en mode froid (°C). */
  targetCooling: number;
  /** Vitesse ventilation. */
  fanSpeed: FanSpeed;
  /** Oscillation horizontale. */
  swingHorizontal: SwingMode;
  /** Oscillation verticale. */
  swingVertical: SwingMode;
};

const TARGET_MIN = 16;
const TARGET_MAX = 30;

function clampTarget(v: number): number {
  return Math.max(TARGET_MIN, Math.min(TARGET_MAX, Math.round(v * 2) / 2));
}

class DaikinState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());

  units = $state<DaikinUnit[]>([
    {
      id: 'salon',
      name: 'Daikin Salon',
      zone: 'Séjour',
      online: true,
      onOff: true,
      operationMode: 'heating',
      outdoorTempC: 14.5,
      targetHeating: 22,
      targetCooling: 24,
      fanSpeed: 'auto',
      swingHorizontal: 'off',
      swingVertical: 'off'
    },
    {
      id: 'sdb',
      name: 'Daikin SdB',
      zone: 'Salle de bain',
      online: true,
      onOff: false,
      operationMode: 'heating',
      outdoorTempC: 14.5,
      targetHeating: 21,
      targetCooling: 25,
      fanSpeed: 'auto',
      swingHorizontal: 'off',
      swingVertical: 'off'
    }
  ]);

  private mutate(unitId: string, patch: Partial<DaikinUnit>) {
    const idx = this.units.findIndex((u) => u.id === unitId);
    if (idx < 0) return;
    this.units[idx] = { ...this.units[idx], ...patch };
    this.lastUpdate = new Date();
  }

  setOnOff(unitId: string, onOff: boolean) {
    this.mutate(unitId, { onOff });
  }
  setOperationMode(unitId: string, operationMode: DaikinOperationMode) {
    this.mutate(unitId, { operationMode });
  }
  setTargetHeating(unitId: string, v: number) {
    this.mutate(unitId, { targetHeating: clampTarget(v) });
  }
  setTargetCooling(unitId: string, v: number) {
    this.mutate(unitId, { targetCooling: clampTarget(v) });
  }
  setFanSpeed(unitId: string, fanSpeed: FanSpeed) {
    this.mutate(unitId, { fanSpeed });
  }
  setSwingHorizontal(unitId: string, swingHorizontal: SwingMode) {
    this.mutate(unitId, { swingHorizontal });
  }
  setSwingVertical(unitId: string, swingVertical: SwingMode) {
    this.mutate(unitId, { swingVertical });
  }
}

export const daikin = new DaikinState();
