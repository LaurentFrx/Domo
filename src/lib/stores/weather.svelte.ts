/**
 * Weather store — météo Sanguinet (Landes) RÉELLE via /api/weather (Open-Meteo).
 *
 * Le mock (constructor) ne sert plus que de placeholder SSR/initial avant le 1er
 * fetch ; dès `connect()`, les vraies valeurs Open-Meteo remplacent tout. La météo
 * bouge lentement → poll 20 min, visibility-aware (refetch au retour de visibilité).
 */

import { hourOfDay, outdoorTemp, outdoorHumidity } from '$utils/mock-curves';

export type WeatherCondition = 'clear' | 'partly-cloudy' | 'cloudy' | 'rain' | 'thunderstorm';

export type DailyForecast = {
  date: Date;
  tempMin: number;
  tempMax: number;
  condition: WeatherCondition;
  pop: number; // probability of precipitation 0-100
};

const REFRESH_MS = 20 * 60 * 1000;

interface ApiCurrent {
  tempC: number;
  humidity: number;
  windSpeedKmh: number;
  windDirection: number;
  condition: WeatherCondition;
  uvIndex: number;
}
interface ApiPayload {
  current: ApiCurrent;
  forecast3d: {
    date: string;
    tempMin: number;
    tempMax: number;
    condition: WeatherCondition;
    pop: number;
  }[];
}

class WeatherState {
  mode = $state<'mock' | 'direct'>('mock');
  connected = $state(false);
  lastUpdate = $state<Date | null>(new Date());

  tempC = $state(0);
  humidity = $state(0); // %
  windSpeedKmh = $state(0);
  windDirection = $state(0); // degrés 0-360
  condition = $state<WeatherCondition>('partly-cloudy');
  uvIndex = $state(5);

  forecast3d = $state<DailyForecast[]>([]);

  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  constructor() {
    this.generateMock(); // placeholder initial (remplacé dès le 1er fetch réel)
  }

  /** Placeholder déterministe (avant le 1er fetch / si Open-Meteo injoignable). */
  private generateMock() {
    const h = hourOfDay();
    this.tempC = +outdoorTemp(h).toFixed(1);
    this.humidity = Math.round(outdoorHumidity(h));
    this.windSpeedKmh = 12 + Math.round(Math.sin(h) * 6);
    this.windDirection = 270;
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
        condition: (i === 1 ? 'cloudy' : 'partly-cloudy') as WeatherCondition,
        pop: i === 1 ? 40 : 10
      };
    });
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.#visibilityHandler !== null) return; // idempotent
    this.#visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.#start();
      } else {
        this.#stop();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
    this.poll();
    this.#start();
  }

  disconnect() {
    this.#stop();
    if (this.#visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
  }

  #start() {
    this.#timer ??= setInterval(() => this.poll(), REFRESH_MS);
  }

  #stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async poll() {
    try {
      const res = await fetch('/api/weather', { signal: AbortSignal.timeout(13_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as ApiPayload;
      const c = p.current;
      this.tempC = c.tempC;
      this.humidity = c.humidity;
      this.windSpeedKmh = c.windSpeedKmh;
      this.windDirection = c.windDirection;
      this.condition = c.condition;
      this.uvIndex = c.uvIndex;
      this.forecast3d = (p.forecast3d ?? []).map((f) => ({
        date: new Date(f.date),
        tempMin: f.tempMin,
        tempMax: f.tempMax,
        condition: f.condition,
        pop: f.pop
      }));
      this.mode = 'direct';
      this.connected = true;
      this.lastUpdate = new Date();
    } catch {
      // Open-Meteo injoignable → on garde le dernier état (placeholder ou réel).
      this.connected = false;
    }
  }
}

export const weather = new WeatherState();
