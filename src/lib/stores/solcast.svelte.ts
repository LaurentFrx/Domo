/**
 * Solcast store — prévisions production PV (P10/P50/P90).
 *
 * Modes :
 *   - 'mock'    : courbe gaussienne 48h pré-calculée
 *   - 'proxy'   : via HA (futur)
 *   - 'direct'  : Solcast API REST (futur, polling 4-6×/jour)
 */

import { solarPV } from '$utils/mock-curves';

export type ForecastPoint = {
  time: Date;
  p10: number; // kW
  p50: number;
  p90: number;
};

export type ForecastConfidence = 'high' | 'medium' | 'low';

class SolcastState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());
  forecast = $state<ForecastPoint[]>([]);
  confidence = $state<ForecastConfidence>('high');

  constructor() {
    this.generateMock();
  }

  private generateMock() {
    const now = new Date();
    const startHour = now.getHours();
    const points: ForecastPoint[] = [];

    for (let i = 0; i < 48; i++) {
      const hour = (startHour + i) % 24;
      const time = new Date(now.getTime() + i * 3600 * 1000);
      const peakKw = 2.3 + Math.sin(i * 0.5) * 0.4;
      const p50 = solarPV(hour, peakKw);
      points.push({
        time,
        p10: p50 * 0.65,
        p50,
        p90: p50 * 1.25
      });
    }

    this.forecast = points;
  }

  /** Total kWh prévu pour les prochaines 24h (P50). */
  get expected24hKwh(): number {
    return this.forecast.slice(0, 24).reduce((s, p) => s + p.p50, 0);
  }
}

export const solcast = new SolcastState();
