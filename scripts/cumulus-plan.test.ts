/**
 * Tests du modèle économique du chauffe-eau (planHeating — PUR, ÉTAPE 2b).
 *   pnpm test:plan
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHeating } from '../src/lib/server/cumulus/plan.ts';
import type { PlanInput } from '../src/lib/server/cumulus/plan.ts';
import type { PlannerConfig } from '../src/lib/server/cumulus/types.ts';

const NOW = 1_700_000_000_000;

function planner(o: Partial<PlannerConfig> = {}): PlannerConfig {
  return {
    enabled: true,
    reserveShowers: 2,
    fullFraction: 0.95,
    horizonH: 18,
    peakMinW: 1500,
    heatPowerW: 2955,
    freeSurplusSocPct: 98,
    eveningReserveWh: 3000,
    maxImportW: 5500,
    ...o
  };
}

function inp(o: Partial<PlanInput> = {}): PlanInput {
  return {
    now: NOW,
    hourOfDay: 14,
    eAvailWh: 8000,
    eFullWh: 15000,
    eDoucheWh: 2000,
    tTankC: 45,
    tRoomC: 22,
    lossCoeffWhPerCh: 2.1,
    pvTotalW: 0,
    houseW: 400,
    gridPowerW: 0,
    cumulusPowerW: 0,
    batteryEnergyWh: 4000,
    batteryChargeW: 0,
    batteryDischargeW: 0,
    socPct: 60,
    isHC: false,
    priceHp: 0.2318,
    priceHc: 0.1812,
    forecast: [],
    ...o
  };
}

test('ballon plein → wait', () => {
  const p = planHeating(inp({ eAvailWh: 14500, eFullWh: 15000 }), planner());
  assert.equal(p.action, 'wait');
  assert.match(p.reason, /plein/);
});

test('surplus solaire libre (batterie pleine + PV + pas d’import) → heat_now, confiance haute', () => {
  const p = planHeating(
    inp({ eAvailWh: 8000, pvTotalW: 2400, houseW: 400, gridPowerW: -10, socPct: 100 }),
    planner()
  );
  assert.equal(p.action, 'heat_now');
  assert.equal(p.surplusConfidence, 'haute');
  assert.ok(p.surplusFreeW > 0);
  assert.ok(p.costNowEur < p.costHcEur, 'chauffer sur surplus doit coûter moins que la HC');
});

test('PV mais batterie en charge (pas pleine) → PAS de surplus libre → pas heat_now', () => {
  const p = planHeating(
    inp({
      eAvailWh: 8000,
      pvTotalW: 2000,
      houseW: 400,
      gridPowerW: 0,
      socPct: 60,
      batteryChargeW: 1500
    }),
    planner()
  );
  assert.notEqual(p.action, 'heat_now');
  assert.equal(p.surplusConfidence, 'nulle');
  assert.equal(p.surplusFreeW, -1);
});

test('réserve basse + pic solaire à venir → wait_solar (moins cher que HC)', () => {
  const fc = [{ hoursAhead: 3, hour: 14, pvW: 2200 }];
  const p = planHeating(inp({ eAvailWh: 4000, hourOfDay: 10, forecast: fc }), planner());
  assert.equal(p.action, 'wait_solar');
  assert.ok(p.deficitWh > 0);
});

test('nuit HC + déficit + backstop atteint → heat_hc', () => {
  const p = planHeating(inp({ eAvailWh: 3000, hourOfDay: 7, isHC: true }), planner());
  assert.equal(p.action, 'heat_hc');
  assert.ok(p.backstopHcHour !== null);
});

test('nuit HC + déficit mais AVANT le backstop → wait (finir juste à temps)', () => {
  const p = planHeating(inp({ eAvailWh: 3000, hourOfDay: 2, isHC: true }), planner());
  assert.equal(p.action, 'wait');
});

test('conso maison élevée (induction) → délestage → wait (garde 6 kVA)', () => {
  const p = planHeating(
    inp({ eAvailWh: 5000, pvTotalW: 2000, houseW: 2800, gridPowerW: 3200, socPct: 100 }),
    planner()
  );
  assert.equal(p.action, 'wait');
  assert.match(p.reason, /conso|kVA|différée/i);
});

test('réserve OK, pas de surplus → wait (on garde la place pour le gratuit)', () => {
  const p = planHeating(inp({ eAvailWh: 10000, pvTotalW: 0, hourOfDay: 16 }), planner());
  assert.equal(p.action, 'wait');
  assert.equal(p.deficitWh, 0);
});

test('le plan chiffre toujours la valeur économique (coûts, appoint, backstop)', () => {
  const p = planHeating(inp({ eAvailWh: 4000, hourOfDay: 6, isHC: true }), planner());
  assert.ok(p.costHcEur > 0);
  assert.equal(typeof p.costNowEur, 'number');
  assert.equal(typeof p.applianceW, 'number');
  assert.ok(p.backstopHcHour !== null);
});
