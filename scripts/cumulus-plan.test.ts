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
    clipSocPct: 97,
    eveningBaseW: 250,
    dinnerWh: 800,
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
    setpointC: 59,
    pvOnSbW: 0,
    pvApsW: 0,
    houseW: 300,
    gridPowerW: 0,
    cumulusPowerW: 0,
    heatingSinceMin: 0,
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

test('réserve du soir : fin d’après-midi + batterie basse → la batterie est réservée, pas de heat_now', () => {
  const p = planHeating(
    inp({
      eAvailWh: 3000, // déficit réel
      hourOfDay: 17.5,
      pvOnSbW: 700,
      pvApsW: 300,
      houseW: 300,
      batteryEnergyWh: 1500, // sous le besoin du soir (~2,4 kWh)
      socPct: 35
    }),
    planner()
  );
  assert.notEqual(p.action, 'heat_now');
  assert.equal(p.batteryCoverW, 0, 'batterie réservée au soir → réattribuée à EDF');
  assert.ok(p.eveningNeedWh > 1000);
  assert.ok(p.gridDrawW > 300);
});

test('péage de stockage : coûts « kWh utile » chiffrés (pertes d’ici 7 h 30)', () => {
  const p = planHeating(inp({ eAvailWh: 4000, hourOfDay: 15 }), planner());
  assert.ok(p.storageLossWh > 500, 'chauffer à 15 h → pertes sensibles jusqu’au matin');
  assert.ok(p.costHcEur > 0.181, 'le coût HC du kWh utile inclut un petit péage');
  const pNight = planHeating(inp({ eAvailWh: 4000, hourOfDay: 6, isHC: true }), planner());
  assert.ok(pNight.storageLossWh < p.storageLossWh, 'chauffer au petit matin perd moins');
});

// ─── ANGLE MORT n°1 : l'écrêtage (bug du 02/07 — injection jetée, plan « wait ») ───

test('BUG 02/07 : injection massive + PV mesuré effondré (écrêtage) → heat_now', () => {
  // Batteries pleines → solar_power_w ≈ 0 alors que la maison JETTE 790 W au réseau.
  const p = planHeating(
    inp({
      eAvailWh: 13000, // réserve confortable (6,5 douches) — le ballon doit QUAND MÊME se remplir
      hourOfDay: 13,
      pvOnSbW: 50, // écrêté : les SB ne produisent que la demande
      pvApsW: 900,
      houseW: 150,
      gridPowerW: -790, // injection = énergie PERDUE (pas de revente)
      socPct: 100,
      batteryChargeW: 0
    }),
    planner()
  );
  assert.equal(p.action, 'heat_now');
  assert.match(p.reason, /jetés|écrêt/);
});

test('écrêtage inféré SANS injection franche (SoC 100, charge 0, jour) → heat_now', () => {
  const p = planHeating(
    inp({
      eAvailWh: 13000,
      hourOfDay: 14,
      pvOnSbW: 300,
      pvApsW: 400,
      houseW: 650, // la maison absorbe presque tout → injection ~0, mais l'écrêtage est là
      gridPowerW: -50,
      socPct: 100,
      batteryChargeW: 0
    }),
    planner()
  );
  assert.equal(p.action, 'heat_now');
  assert.match(p.reason, /écrêt|batteries pleines/);
});

test('PAS de faux positif : matin, batteries en charge (60 %) + réserve OK → wait', () => {
  const p = planHeating(
    inp({
      eAvailWh: 13000,
      hourOfDay: 10,
      pvOnSbW: 2000,
      pvApsW: 0,
      houseW: 300,
      gridPowerW: 0,
      socPct: 60,
      batteryChargeW: 1500 // le PV remplit la batterie : pas de surplus libre
    }),
    planner()
  );
  assert.equal(p.action, 'wait');
});

test('MAINTIEN en chauffe : EDF réel ~0 + batterie modérée → heat_now (on continue)', () => {
  const p = planHeating(
    inp({
      cumulusPowerW: 2900,
      gridPowerW: 40,
      batteryDischargeW: 900,
      socPct: 70,
      batteryEnergyWh: 3500,
      hourOfDay: 15,
      eAvailWh: 9000
    }),
    planner()
  );
  assert.equal(p.measured, true);
  assert.equal(p.action, 'heat_now');
  assert.match(p.reason, /continue/);
});

test('STOP en chauffe : nuage → EDF réel 800 W → pas de maintien', () => {
  const p = planHeating(
    inp({
      cumulusPowerW: 2900,
      gridPowerW: 800, // le nuage fait basculer la chauffe sur EDF
      batteryDischargeW: 1500,
      socPct: 70,
      hourOfDay: 15,
      eAvailWh: 9000
    }),
    planner()
  );
  assert.notEqual(p.action, 'heat_now');
});

test('STOP en chauffe : la batterie entame sa réserve du soir → pas de maintien', () => {
  const p = planHeating(
    inp({
      cumulusPowerW: 2900,
      gridPowerW: 20, // EDF propre… mais c'est la batterie qui paie
      batteryDischargeW: 2400,
      socPct: 34,
      batteryEnergyWh: 1400, // sous le besoin du soir (~2,3 kWh à 18 h)
      hourOfDay: 18,
      eAvailWh: 9000
    }),
    planner()
  );
  assert.notEqual(p.action, 'heat_now');
});

test('GRÂCE de démarrage : SolarBank en régulation (2 min, grid encore haut) → on ne coupe pas', () => {
  // Mesuré 02/07 : les SB mettent ~2-3 min à monter (ON 12:59:23 → 2400 W à 13:02).
  const p = planHeating(
    inp({
      cumulusPowerW: 3000,
      gridPowerW: 2430, // les SB n'ont pas encore réagi
      heatingSinceMin: 1.5,
      pvOnSbW: 500,
      pvApsW: 900,
      socPct: 100,
      hourOfDay: 15,
      eAvailWh: 13000
    }),
    planner()
  );
  assert.equal(p.action, 'heat_now');
  assert.match(p.reason, /régulation|lancée/);
});

test('MAINTIEN économique : 430 W EDF sur 2960 (0,05 €/kWh utile) → on continue', () => {
  // Couper jetterait ~2,5 kW de solaire pour économiser 0,10 €/h.
  const p = planHeating(
    inp({
      cumulusPowerW: 2960,
      gridPowerW: 430,
      batteryDischargeW: 0,
      heatingSinceMin: 10,
      socPct: 100,
      hourOfDay: 15,
      eAvailWh: 13000
    }),
    planner()
  );
  assert.equal(p.action, 'heat_now');
  assert.ok(p.costNowEur < p.costHcEur);
});

test('STOP économique : nuage total (2600 W EDF, ~10 % autoconso) → on coupe', () => {
  const p = planHeating(
    inp({
      cumulusPowerW: 2900,
      gridPowerW: 2600,
      batteryDischargeW: 200,
      heatingSinceMin: 10,
      pvOnSbW: 100,
      socPct: 60,
      hourOfDay: 15,
      eAvailWh: 13000
    }),
    planner()
  );
  assert.notEqual(p.action, 'heat_now');
});

test('chauffe HC nocturne en cours : maintenue tant que le déficit persiste (via besoin daté)', () => {
  const p = planHeating(
    inp({
      cumulusPowerW: 2900,
      gridPowerW: 2900, // la nuit, tout vient d'EDF (HC) — gridClean est faux, (d) maintient
      hourOfDay: 6.5,
      isHC: true,
      eAvailWh: 3000
    }),
    planner()
  );
  assert.equal(p.action, 'heat_hc');
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
