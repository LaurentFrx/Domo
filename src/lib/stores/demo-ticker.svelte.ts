/**
 * Demo ticker — fait varier les données mockées toutes les 3s pour montrer
 * les animations. Ne tourne que si `dashboard.connectionStatus === 'mock'`.
 */

import { dashboard } from './dashboard.svelte';

let intervalId: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 3000;

const TEMP_MIN = 35;
const TEMP_MAX = 75;
const TEMP_AMP = 0.8;

const SOLAR_MIN = 0;
const SOLAR_MAX = 4.5;
const SOLAR_AMP = 0.15;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function jitter(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

function tick(): void {
  if (dashboard.connectionStatus !== 'mock') return;

  // ─── Température cumulus ───
  const nextTemp = clamp(dashboard.cumulusTemp + jitter(TEMP_AMP), TEMP_MIN, TEMP_MAX);
  dashboard.cumulusTemp = Number(nextTemp.toFixed(1));

  // ─── Gauge suit la température (échelle 35→75 → 0→100) ───
  dashboard.cumulusGaugePercent = clamp(
    ((nextTemp - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * 100,
    0,
    100
  );

  // ─── Tendance température (subtle drift) ───
  dashboard.cumulusTempTrend = Number(
    clamp(dashboard.cumulusTempTrend + jitter(0.15), -8, 8).toFixed(1)
  );

  // ─── Puissance solaire ───
  const nextSolar = clamp(dashboard.solarPower + jitter(SOLAR_AMP), SOLAR_MIN, SOLAR_MAX);
  dashboard.solarPower = Number(nextSolar.toFixed(2));

  // ─── Surplus suit le solaire (proportionnel, en W) ───
  dashboard.solarSurplus = Math.round(nextSolar * 200);

  // ─── Auto-conso (oscille) ───
  dashboard.solarSelfConsumption = Math.round(
    clamp(dashboard.solarSelfConsumption + jitter(1.5), 60, 100)
  );

  // ─── Batterie : +0.2%/tick en charge, -0.15%/tick en décharge ───
  if (dashboard.batteryStatus === 'charge') {
    const next = clamp(dashboard.batteryLevel + 0.2, 0, 100);
    dashboard.batteryLevel = Number(next.toFixed(1));
    if (dashboard.batteryLevel >= 100) {
      dashboard.batteryStatus = 'idle';
    }
  } else if (dashboard.batteryStatus === 'discharge') {
    const next = clamp(dashboard.batteryLevel - 0.15, 0, 100);
    dashboard.batteryLevel = Number(next.toFixed(1));
    if (dashboard.batteryLevel <= 5) {
      dashboard.batteryStatus = 'charge';
    }
  }

  dashboard.lastUpdate = new Date();
}

export function startDemoTicker(): void {
  if (intervalId !== null) return;
  intervalId = setInterval(tick, TICK_MS);
}

export function stopDemoTicker(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
