/**
 * Tests du modèle AUTOCONSOMMATION du chauffe-eau (planHeating — PUR, ÉTAPE 2b).
 * Objectif : ne PAS ponctionner EDF ; décomposer la chauffe en PV / batterie / EDF.
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
    sbOutMaxW: 2400,
    socReservePct: 30,
    gridTolW: 300,
    purePvFraction: 0.8,
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
    pvOnSbW: 0,
    pvApsW: 0,
    houseW: 300,
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

test('surplus solaire franc (le PV seul couvre) → heat_now, ~0 EDF, moins cher que la HC', () => {
  const p = planHeating(
    inp({ eAvailWh: 8000, pvOnSbW: 2000, pvApsW: 900, houseW: 200, socPct: 100 }),
    planner()
  );
  assert.equal(p.action, 'heat_now');
  assert.ok(p.gridDrawW <= 300, `EDF attendu ~0, obtenu ${p.gridDrawW} W`);
  assert.ok(p.autoconsoPct >= 90);
  assert.ok(p.costNowEur < p.costHcEur, 'chauffer sur solaire doit coûter moins que la HC');
});

test('déficit + solaire+batterie couvrent (EDF propre) → heat_now (autoconsommation)', () => {
  const p = planHeating(
    inp({ eAvailWh: 3000, pvOnSbW: 800, pvApsW: 700, houseW: 200, socPct: 80 }),
    planner()
  );
  assert.equal(p.action, 'heat_now');
  assert.ok(p.deficitWh > 0);
  assert.ok(p.batteryCoverW > 0, 'la batterie participe le jour');
  assert.ok(p.gridDrawW <= 300);
});

test('déficit + gros consommateur (conso maison élevée) + solaire à venir → wait_solar', () => {
  const fc = [{ hoursAhead: 3, hour: 14, pvW: 2200 }];
  const p = planHeating(
    inp({ eAvailWh: 3000, hourOfDay: 10, houseW: 2500, pvOnSbW: 500, pvApsW: 200, forecast: fc }),
    planner()
  );
  assert.equal(p.action, 'wait_solar');
  assert.ok(p.gridDrawW > 300, 'chauffer maintenant ponctionnerait EDF');
});

test('gros consommateur en journée, sans solaire suffisant ni à venir → wait (éviter EDF)', () => {
  const p = planHeating(
    inp({ eAvailWh: 3000, hourOfDay: 17, houseW: 2800, pvOnSbW: 300, pvApsW: 100 }),
    planner()
  );
  assert.equal(p.action, 'wait');
  assert.ok(p.gridDrawW > 300);
});

test('nuit HC + déficit + backstop atteint → heat_hc, batterie NON puisée', () => {
  const p = planHeating(
    inp({ eAvailWh: 3000, hourOfDay: 7, isHC: true, pvOnSbW: 0, pvApsW: 0 }),
    planner()
  );
  assert.equal(p.action, 'heat_hc');
  assert.equal(
    p.batteryCoverW,
    0,
    'la nuit, la batterie est la réserve du soir — pas pour le ballon'
  );
  assert.ok(p.backstopHcHour !== null);
});

test('nuit HC + déficit mais AVANT le backstop → wait (finir juste à temps)', () => {
  const p = planHeating(inp({ eAvailWh: 3000, hourOfDay: 2, isHC: true }), planner());
  assert.equal(p.action, 'wait');
});

test('réserve OK, pas de surplus → wait (ne pas vider la batterie pour rien)', () => {
  const p = planHeating(inp({ eAvailWh: 10000, pvOnSbW: 0, hourOfDay: 16 }), planner());
  assert.equal(p.action, 'wait');
  assert.equal(p.deficitWh, 0);
});

test('la nuit, la batterie n’est jamais comptée pour la chauffe (réserve du soir)', () => {
  const p = planHeating(
    inp({ eAvailWh: 3000, hourOfDay: 3, isHC: true, socPct: 90, pvOnSbW: 0 }),
    planner()
  );
  assert.equal(p.batteryCoverW, 0);
  assert.equal(p.gridDrawW, 2955, 'toute la chauffe viendrait d’EDF (HC) la nuit');
});

test('ballon EN CHAUFFE → décompo MESURÉE sur le grid EM-50 réel (injection → 0 EDF)', () => {
  const p = planHeating(
    inp({
      cumulusPowerW: 2900,
      gridPowerW: -30,
      batteryDischargeW: 256,
      pvOnSbW: 1900,
      pvApsW: 960,
      houseW: 120,
      socPct: 48,
      eAvailWh: 13000
    }),
    planner()
  );
  assert.equal(p.measured, true);
  assert.equal(p.gridNowW, -30);
  assert.equal(p.gridDrawW, 0, 'injection réseau → 0 EDF réel (pas de projection)');
  assert.equal(p.batteryCoverW, 256, 'batterie = décharge réelle mesurée');
  assert.equal(p.autoconsoPct, 100);
  assert.equal(p.costNowEur, 0);
});

test('ballon EN CHAUFFE qui soutire → gridDrawW = grid EM-50 réel mesuré', () => {
  const p = planHeating(
    inp({ cumulusPowerW: 2900, gridPowerW: 600, batteryDischargeW: 1500 }),
    planner()
  );
  assert.equal(p.measured, true);
  assert.equal(p.gridDrawW, 600, 'EDF = grid EM-50 réel, pas une projection');
  assert.ok(p.costNowEur > 0);
});

test('le plan chiffre toujours la décomposition (PV / batterie / EDF / autoconso / coûts)', () => {
  const p = planHeating(
    inp({ eAvailWh: 4000, pvOnSbW: 1000, pvApsW: 400, houseW: 300 }),
    planner()
  );
  assert.equal(typeof p.pvCoverW, 'number');
  assert.equal(typeof p.batteryCoverW, 'number');
  assert.equal(typeof p.gridDrawW, 'number');
  assert.ok(p.autoconsoPct >= 0 && p.autoconsoPct <= 100);
  assert.equal(p.pvCoverW + p.batteryCoverW + p.gridDrawW, 2955, 'la somme = puissance de chauffe');
  assert.ok(p.costHcEur > 0);
});
