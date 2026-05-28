/**
 * Daikin store — climatisation Onecta cloud (2 unités : Salon + SdB).
 *
 * Modes :
 *   - 'mock'    : valeurs réalistes
 *   - 'proxy'   : via HA (futur)
 *   - 'direct'  : python-daikin-onecta direct (futur)
 */

export type DaikinMode = 'auto' | 'heat' | 'cool' | 'fan' | 'off';
export type FanSpeed = 'auto' | 'low' | 'mid' | 'high';

export type DaikinUnit = {
  id: string;
  name: string;
  zone: string;
  /** Température ambiante mesurée (°C) */
  ambient: number;
  /** Consigne (°C) */
  target: number;
  mode: DaikinMode;
  fanSpeed: FanSpeed;
  /** Puissance instantanée estimée (W) */
  powerW: number;
  online: boolean;
};

class DaikinState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());

  units = $state<DaikinUnit[]>([
    {
      id: 'salon',
      name: 'Daikin Salon',
      zone: 'Séjour',
      ambient: 21.5,
      target: 22,
      mode: 'heat',
      fanSpeed: 'auto',
      powerW: 850,
      online: true
    },
    {
      id: 'sdb',
      name: 'Daikin SdB',
      zone: 'Salle de bain',
      ambient: 19.8,
      target: 21,
      mode: 'heat',
      fanSpeed: 'low',
      powerW: 450,
      online: true
    }
  ]);

  /** Puissance totale Daikin (somme des unités ON). */
  totalPowerW = $derived(
    this.units.reduce((s, u) => s + (u.mode === 'off' ? 0 : u.powerW), 0)
  );

  setTarget(unitId: string, target: number) {
    const u = this.units.find((x) => x.id === unitId);
    if (u) u.target = Math.max(16, Math.min(30, target));
  }

  setMode(unitId: string, mode: DaikinMode) {
    const u = this.units.find((x) => x.id === unitId);
    if (u) {
      u.mode = mode;
      u.powerW = mode === 'off' ? 0 : u.zone === 'Séjour' ? 850 : 450;
    }
  }

  setFanSpeed(unitId: string, fanSpeed: FanSpeed) {
    const u = this.units.find((x) => x.id === unitId);
    if (u) u.fanSpeed = fanSpeed;
  }
}

export const daikin = new DaikinState();
