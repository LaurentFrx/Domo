/**
 * Weather store — météo Sanguinet (Landes) via Open-Meteo.
 *
 * Modes :
 *   - 'mock'    : valeurs calculées d'après l'heure
 *   - 'proxy'   : via HA (futur)
 *   - 'direct'  : Open-Meteo API (futur, gratuit)
 */

import { hourOfDay, outdoorTemp, outdoorHumidity } from '$utils/mock-curves';

export type WeatherCondition =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'rain'
  | 'thunderstorm';

export type DailyForecast = {
  date: Date;
  tempMin: number;
  tempMax: number;
  condition: WeatherCondition;
  pop: number; // probability of precipitation 0-100
};

class WeatherState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());

  tempC = $state(0);
  humidity = $state(0); // %
  windSpeedKmh = $state(0);
  windDirection = $state(0); // degrés 0-360
  condition = $state<WeatherCondition>('partly-cloudy');
  uvIndex = $state(5);

  forecast3d = $state<DailyForecast[]>([]);

  constructor() {
    this.generateMock();
  }

  private generateMock() {
    const h = hourOfDay();
    this.tempC = +outdoorTemp(h).toFixed(1);
    this.humidity = Math.round(outdoorHumidity(h));
    this.windSpeedKmh = 12 + Math.round(Math.sin(h) * 6);
    this.windDirection = 270; // Ouest, typique Landes
    this.condition = 'partly-cloudy';
    this.uvIndex = Math.max(0, Math.round(7 * Math.max(0, Math.sin(((h - 6) / 12) * Math.PI))));

    const today = new Date();
    this.forecast3d = Array.from({ length: 3 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i + 1);
      return {
        date: d,
        tempMin: 12 + i,
        tempMax: 21 + i,
        condition: i === 1 ? 'cloudy' : 'partly-cloudy',
        pop: i === 1 ? 40 : 10
      };
    });
  }
}

export const weather = new WeatherState();
