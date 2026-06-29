/**
 * Tests unitaires du planificateur prédictif (planHeating — PUR, ÉTAPE 2a).
 *
 *   pnpm test:plan
 *   # ou : node --experimental-strip-types --test scripts/cumulus-plan.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHeating } from '../src/lib/server/cumulus/plan.ts';
import type { PlanInput, PlanForecastPoint } from '../src/lib/server/cumulus/plan.ts';
import type { PlannerConfig } from '../src/lib/server/cumulus/types.ts';

const NOW = 1_700_000_000_000;

function planner(o: Partial<PlannerConfig> = {}): PlannerConfig {
  return {
    enabled: true,
    reserveShowers: 3,
    fullFraction: 0.95,
    horizonH: 18,
    peakFraction: 0.6,
    peakMinW: 1800,
    socFloorPct: 50,
    ...o
  };
}

function inp(o: Partial<PlanInput> = {}): PlanInput {
  return {
    now: NOW,
    eAvailWh: 8000,
    eFullWh: 15000,
    eDoucheWh: 2000, // → réserve plancher = 3 × 2000 = 6000 Wh
    isHC: false,
    socPct: 70,
    forecast: [],
    ...o
  };
}

/** Pic PV à l'heure courante (W). */
const peakNow = (pvW: number): PlanForecastPoint[] => [
  { hoursAhead: 0, hour: 13, pvW },
  { hoursAhead: 1, hour: 14, pvW: pvW * 0.8 }
];

test('ballon plein → wait', () => {
  const p = planHeating(inp({ eAvailWh: 14500, eFullWh: 15000 }), planner());
  assert.equal(p.action, 'wait');
  assert.match(p.reason, /plein/);
});

test('pic PV + batterie OK → heat_now (chauffe solaire)', () => {
  const p = planHeating(inp({ eAvailWh: 8000, socPct: 70, forecast: peakNow(4000) }), planner());
  assert.equal(p.action, 'heat_now');
  assert.equal(p.targetHour, 13);
});

test('pic PV mais batterie basse → wait (priorité recharge batterie)', () => {
  const p = planHeating(inp({ eAvailWh: 8000, socPct: 30, forecast: peakNow(4000) }), planner());
  assert.equal(p.action, 'wait');
  assert.match(p.reason, /batterie/);
});

test('réserve basse + pic PV à venir → wait_solar (attend le pic)', () => {
  const fc: PlanForecastPoint[] = [
    { hoursAhead: 0, hour: 9, pvW: 600 },
    { hoursAhead: 4, hour: 13, pvW: 4000 }
  ];
  const p = planHeating(inp({ eAvailWh: 4000, forecast: fc }), planner());
  assert.equal(p.action, 'wait_solar');
  assert.equal(p.targetHour, 13);
});

test('réserve basse + pas de soleil + HC → heat_hc', () => {
  const fc: PlanForecastPoint[] = [{ hoursAhead: 0, hour: 3, pvW: 0 }];
  const p = planHeating(inp({ eAvailWh: 4000, isHC: true, forecast: fc }), planner());
  assert.equal(p.action, 'heat_hc');
});

test('réserve basse + pas de soleil + HP → wait (jusqu’aux creuses)', () => {
  const fc: PlanForecastPoint[] = [{ hoursAhead: 0, hour: 17, pvW: 200 }];
  const p = planHeating(inp({ eAvailWh: 4000, isHC: false, forecast: fc }), planner());
  assert.equal(p.action, 'wait');
});

test('réserve OK hors pic → wait (garde la place pour le solaire)', () => {
  const fc: PlanForecastPoint[] = [{ hoursAhead: 0, hour: 10, pvW: 800 }];
  const p = planHeating(inp({ eAvailWh: 10000, forecast: fc }), planner());
  assert.equal(p.action, 'wait');
  assert.match(p.reason, /OK/);
});

test('batterie indisponible (socPct null) → marge batterie non bloquante', () => {
  const p = planHeating(inp({ eAvailWh: 8000, socPct: null, forecast: peakNow(4000) }), planner());
  assert.equal(p.action, 'heat_now');
});

test('le pic doit dépasser peakMinW absolu (pas de chauffe pour un petit pic)', () => {
  // pic du jour à 1000 W : 0,6×1000 = 600 mais peakMinW = 1800 → pas un « pic »
  const p = planHeating(inp({ eAvailWh: 4000, forecast: peakNow(1000), isHC: false }), planner());
  assert.notEqual(p.action, 'heat_now');
});
