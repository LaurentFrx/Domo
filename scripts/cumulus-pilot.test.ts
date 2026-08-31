/**
 * Tests du PILOTE V2 (pilotStep — machine à phases « règle zéro achat EDF »).
 * Spec validée par Laurent le 03/07/2026.
 *   pnpm test:pilot
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pilotStep, defaultPilotState, type PilotCtx } from '../src/lib/server/cumulus/pilot.ts';
import { sunPosition } from '../src/lib/server/cumulus/sun.ts';
import { defaultCumulusState } from '../src/lib/server/cumulus/state-store.ts';
import type {
  CumulusInputs,
  CumulusConfig,
  CumulusRuntimeState,
  PilotState
} from '../src/lib/server/cumulus/types.ts';
import type { HouseProfile } from '../src/lib/server/cumulus/reserve.ts';

// 3 juillet 2026, 12:00 UTC = 14:00 locale (Paris, été) — plein soleil à Sanguinet.
const NOON = Date.parse('2026-07-03T12:00:00Z');
// 3 juillet 2026, 02:00 UTC = 04:00 locale — nuit, heures creuses.
const NIGHT = Date.parse('2026-07-03T02:00:00Z');
const min = (m: number) => m * 60_000;

function cfg(o: Record<string, unknown> = {}, pilotO: Record<string, unknown> = {}): CumulusConfig {
  return {
    profile: 'solar_first',
    tminConfortC: 45,
    tmaxSondeC: 70,
    rechargeHysteresisC: 5,
    tempOffsetC: 0,
    minOnSec: 300,
    minOffSec: 300,
    antiCyclingSec: 600,
    forecastFaibleKwh: 7,
    autoOffDelaySec: 600,
    tempStaleSec: 1800,
    tankFullPowerW: 250,
    tankFullConfirmSec: 120,
    faultConfirmSec: 300,
    observationMode: false,
    batteryMaxDischargeW: 2400,
    energyModel: { etaHeat: 0.98, eDoucheWhSummer: 2000 } as never,
    pilot: {
      exportOnW: 200,
      observationBeforeOnSec: 180,
      battFullPct: 98,
      chargeIdleW: 120,
      solarStartsPerDay: 2,
      apsMinW: 300,
      minUsefulHeatMin: 45,
      rechargeBufferWh: 500,
      invisibleSurplusMinW: 2000,
      surplusOnW: 2000,
      maxAcSocOnPct: 65,
      graceStartupSec: 240,
      cutBuyW: 150,
      cutBuySustainSec: 30,
      cutBuyHardW: 500,
      batteryDropCutPts: 20,
      batteryFloorCutPct: 40,
      sunElevStartDeg: 20,
      sunAzStartDeg: 120,
      sunElevEndDeg: 30,
      sunAzEndDeg: 252,
      degradedWindowEndH: 15,
      hcEndTarget: '07:15',
      hcPlanHour: 22,
      hcMorningReservePct: 30,
      hcGrey1Factor: 1.3,
      hcGrey2Factor: 1.6,
      reserveShowers: 2,
      fullFraction: 0.95,
      heatPowerW: 2900,
      sb1BatteryIndex: 0,
      latDeg: 44.4792,
      lonDeg: -1.0835,
      apsStaleSec: 300,
      apsMuteFloorW: 30,
      apsMuteConfirmSec: 600,
      apsTwinMinW: 200,
      ...pilotO
    },
    ...o
  } as CumulusConfig;
}

function st(
  o: Partial<CumulusRuntimeState> = {},
  pilotO: Partial<PilotState> = {}
): CumulusRuntimeState {
  // Base = l'état par défaut RÉEL du store : les fixtures n'ont plus à suivre à
  // la main chaque champ ajouté au type (c'est un `energy` manquant qui faisait
  // planter les 52 tests dès que le pilote l'a lu plus tôt dans son flux).
  return {
    ...defaultCumulusState(),
    autoMode: 'auto',
    manualRelayOn: false,
    boostUntilFull: false,
    relayDesired: null,
    lastOnTs: null,
    lastOffTs: null,
    lastTransitionTs: null,
    lowPowerSinceTs: null,
    ballonCharged: false,
    chargedAtTempC: null,
    onSinceTs: null,
    energyDayDate: '2026-07-03',
    energyTodayKwh: 0,
    lastCumulusKwh: null,
    lastDisinfectTs: null,
    lastTickTs: null,
    lastTempC: 50,
    lastReason: 'idle',
    lastSubMode: 'OFF',
    anomaly: 'none',
    pilot: { ...defaultPilotState(), startsDate: '2026-07-03', ...pilotO },
    log: [],
    ...o
  } as CumulusRuntimeState;
}

function inp(o: Partial<CumulusInputs> = {}): CumulusInputs {
  return {
    now: NOON,
    todayParis: '2026-07-03',
    tempC: 50,
    tempAgeMs: 10_000,
    em50Available: true,
    gridPowerW: 0,
    cumulusPowerW: 0,
    cumulusKwh: 100,
    isHC: false,
    minutesToHcEnd: -1,
    priceHp: 0.2318,
    priceHc: 0.1812,
    forecastAvailable: true,
    solNextDaylightKwh: 20,
    solTodayRestKwh: 20,
    forecastD1Kwh: 18,
    forecastD2Kwh: 18,
    relayAvailable: true,
    relayOn: false,
    ankerAvailable: true,
    pvPowerW: 500,
    ankerGridPowerW: 0,
    sbOutputPowerW: 0,
    batteryDischargeW: 0,
    batterySocPct: [99, 99],
    batteryEnergyWh: 5000,
    batteryCapacityWh: 5360,
    batteryChargeW: 0,
    sb3ChargeW: 0,
    sbInputW: [null, null],
    // Max AC locale muette par défaut : la voie saturation est inerte, les tests
    // historiques du chemin « don franc » gardent leur sens tel quel.
    maxAcAvailable: false,
    maxAcSocPct: null,
    maxAcChargeW: null,
    pvApsW: 800,
    apsAvailable: true,
    apsAgeSec: 5,
    apsRecoverableW: 0,
    indoorC: 24,
    outdoorC: 25,
    indoorSources: [],
    outdoorSources: [],
    appliances: [],
    ...o
  } as CumulusInputs;
}

function ctx(o: Partial<PilotCtx> = {}): PilotCtx {
  return {
    eAvailWh: 8000,
    eFullWh: 16000,
    eDoucheWh: 2000,
    lossPerHWh: 70,
    hourLocal: 14,
    minuteOfDay: 840,
    tomorrowParis: '2026-07-04',
    potential: {
      potSb1W: 800,
      potSb2W: 500,
      potTotalW: 2100,
      invisibleSurplusW: 0,
      geoRatioWest: 0.7,
      calibUpdated: false
    },
    ...o
  };
}

// ─── Sanity des éphémérides ───────────────────────────────────────────────────

test('éphémérides : soleil haut à midi local, sous l’horizon la nuit (Sanguinet)', () => {
  const noon = sunPosition(NOON, 44.4792, -1.0835);
  assert.ok(noon.elevationDeg > 55, `élévation midi = ${noon.elevationDeg}`);
  const night = sunPosition(NIGHT, 44.4792, -1.0835);
  assert.ok(night.elevationDeg < 0, `élévation nuit = ${night.elevationDeg}`);
});

// ─── Allumage solaire : les 7 conditions + persistance 3 min ─────────────────

test('don franc au réseau : les conditions démarrent le chrono, PAS d’allumage immédiat', () => {
  const r = pilotStep(inp({ gridPowerW: -450 }), cfg(), st(), ctx());
  assert.equal(r.wantOn, false); // le chrono de 3 min vient de démarrer
  assert.equal(typeof r.pilot.condsSinceTs, 'number');
});

test('don franc tenu 3 min → allumage (wantOn, raison solaire)', () => {
  const r = pilotStep(
    inp({ gridPowerW: -450 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, true);
  assert.equal(r.reason, 'solar');
  assert.equal(r.pilot.solarStartsToday, 1); // allumage spontané compté
});

test('don franc + batteries en charge : l’export PROUVE la saturation (Max AC vivante) → allumage', () => {
  // Ancien monde : « on ne vole jamais leur recharge » (battFull dans le tronc
  // commun). Nouveau monde (Max AC zéro-export, 22/07) : si le compteur DONNE
  // 450 W soutenus PENDANT que la régulation est vivante (Modbus local up),
  // c’est que le parc n’absorbe plus — l’export est la preuve.
  const r = pilotStep(
    inp({
      gridPowerW: -450,
      batterySocPct: [70, 72],
      batteryChargeW: 900,
      maxAcAvailable: true,
      maxAcSocPct: 50,
      maxAcChargeW: 900
    }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, true);
});

test('Max AC MUETTE + packs en charge : l’export ne prouve plus rien → garde historique, pas d’allumage', () => {
  // Si la mesure locale est morte, la régulation zéro-export l’est peut-être
  // aussi : l’export redevient un débordement ordinaire — on ré-exige la garde
  // « batteries pleines » (cloud) comme avant le 22/07.
  const r = pilotStep(
    inp({ gridPowerW: -450, batterySocPct: [70, 72], batteryChargeW: 900, maxAcAvailable: false }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, false); // on ne vole jamais leur recharge
});

// ─── Voie « saturation/réserve » (Max AC zéro-export, 22/07) ─────────────────

test('zéro-export : charge Max AC forte + réserve faite → allumage sans don franc', () => {
  const r = pilotStep(
    inp({ gridPowerW: -30, maxAcAvailable: true, maxAcSocPct: 72, maxAcChargeW: 2200 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, true);
  assert.equal(r.reason, 'solar');
});

test('réserve PAS faite (SoC Max AC < seuil) → pas d’allumage malgré 2,5 kW de charge', () => {
  const r = pilotStep(
    inp({ gridPowerW: -30, maxAcAvailable: true, maxAcSocPct: 55, maxAcChargeW: 2500 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, false);
});

test('surplus réorientable insuffisant → pas d’allumage (budget de drain protégé)', () => {
  const r = pilotStep(
    inp({ gridPowerW: -30, maxAcAvailable: true, maxAcSocPct: 80, maxAcChargeW: 1200 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, false);
});

test('Modbus local muet : la voie saturation est inerte, le don franc reste la voie', () => {
  const r = pilotStep(
    inp({ gridPowerW: -450, maxAcAvailable: false }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, true); // don franc seul, comme avant
});

test('achat en cours : pas d’allumage saturation même avec charge et réserve', () => {
  const r = pilotStep(
    inp({ gridPowerW: 120, maxAcAvailable: true, maxAcSocPct: 80, maxAcChargeW: 2500 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, false);
});

test('lave-vaisselle en marche → maison PAS tranquille → pas d’allumage', () => {
  const r = pilotStep(
    inp({
      gridPowerW: -450,
      appliances: [{ name: 'Lave-vaisselle', topic: 't', onW: 100, powerW: 1800, energyKwh: null }]
    }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, false);
});

test('nuit : fenêtre solaire fermée → pas d’allumage solaire', () => {
  const r = pilotStep(
    inp({ now: NIGHT, gridPowerW: -450 }),
    cfg(),
    st({}, { condsSinceTs: NIGHT - min(4) }),
    ctx({ hourLocal: 4, minuteOfDay: 240 })
  );
  assert.equal(r.wantOn, false);
});

test('quota épuisé (2 spontanés) → pas d’allumage', () => {
  const r = pilotStep(
    inp({ gridPowerW: -450 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4), solarStartsToday: 2 }),
    ctx()
  );
  assert.equal(r.wantOn, false);
});

test('reprise après cession-achat : HORS quota (réponse Laurent Q4)', () => {
  const r = pilotStep(
    inp({ gridPowerW: -450 }),
    cfg(),
    st(
      { lastOffTs: NOON - min(12), lastTransitionTs: NOON - min(12) },
      { condsSinceTs: NOON - min(4), solarStartsToday: 2, lastCessionCause: 'buy' }
    ),
    ctx()
  );
  assert.equal(r.wantOn, true); // le quota est plein mais la reprise est autorisée
  assert.equal(r.pilot.resumesToday, 1);
  assert.equal(r.pilot.solarStartsToday, 2); // inchangé
});

test('ballon plein (95 %) → pas d’allumage', () => {
  const r = pilotStep(
    inp({ gridPowerW: -450 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx({ eAvailWh: 15500, eFullWh: 16000 })
  );
  assert.equal(r.wantOn, false);
});

// ─── Déclencheur de secours : surplus invisible (réponse Laurent Q2) ─────────

test('surplus invisible ≥ 2000 W (batteries pleines, réseau ≈ 0) → allumage', () => {
  const r = pilotStep(
    inp({ gridPowerW: -20, pvPowerW: 150 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx({
      potential: {
        potSb1W: 1600,
        potSb2W: 900,
        potTotalW: 3300,
        invisibleSurplusW: 2350,
        geoRatioWest: 0.7,
        calibUpdated: false
      }
    })
  );
  assert.equal(r.wantOn, true);
  assert.match(r.view.note, /invisible/);
});

test('surplus invisible SOUS le seuil → pas d’allumage', () => {
  const r = pilotStep(
    inp({ gridPowerW: -20, pvPowerW: 150 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx({
      potential: {
        potSb1W: 700,
        potSb2W: 400,
        potTotalW: 1900,
        invisibleSurplusW: 950,
        geoRatioWest: 0.7,
        calibUpdated: false
      }
    })
  );
  assert.equal(r.wantOn, false);
});

// ─── Chauffe en cours : grâce, coupures ───────────────────────────────────────

test('GRÂCE de démarrage : achat 2400 W à 2 min → AUCUN jugement, on continue', () => {
  const r = pilotStep(
    inp({ relayOn: true, cumulusPowerW: 2900, gridPowerW: 2400 }),
    cfg(),
    st({ onSinceTs: NOON - min(2), lastOnTs: NOON - min(2) }),
    ctx()
  );
  assert.equal(r.wantOn, true);
  assert.equal(r.view.phase, 'allumage');
});

test('fin de grâce : l’achat persiste → on renonce (grace_fail)', () => {
  const r = pilotStep(
    inp({ relayOn: true, cumulusPowerW: 2900, gridPowerW: 2400 }),
    cfg(),
    st({ onSinceTs: NOON - min(4.5), lastOnTs: NOON - min(4.5) }),
    ctx()
  );
  assert.equal(r.wantOn, false);
  assert.equal(r.pilot.lastCessionCause, 'grace_fail');
});

test('chauffe établie : achat 300 W depuis 40 s (> 30 s Laurent) → coupure, cause buy', () => {
  const r = pilotStep(
    inp({ relayOn: true, cumulusPowerW: 2900, gridPowerW: 300 }),
    cfg(),
    st(
      { onSinceTs: NOON - min(20), lastOnTs: NOON - min(20) },
      { buyOverSinceTs: NOON - 40_000, socStartOfHeat: 99 }
    ),
    ctx()
  );
  assert.equal(r.wantOn, false);
  assert.equal(r.pilot.lastCessionCause, 'buy');
});

test('chauffe établie : achat 300 W depuis 10 s seulement → on attend encore', () => {
  const r = pilotStep(
    inp({ relayOn: true, cumulusPowerW: 2900, gridPowerW: 300 }),
    cfg(),
    st(
      { onSinceTs: NOON - min(20), lastOnTs: NOON - min(20) },
      { buyOverSinceTs: NOON - 10_000, socStartOfHeat: 99 }
    ),
    ctx()
  );
  assert.equal(r.wantOn, true); // oscillation SolarBank possible — 30 s de confirmation
});

test('achat FRANC 800 W (> 500) → coupure IMMÉDIATE (la cuisine d’abord)', () => {
  const r = pilotStep(
    inp({ relayOn: true, cumulusPowerW: 2900, gridPowerW: 800 }),
    cfg(),
    st({ onSinceTs: NOON - min(20), lastOnTs: NOON - min(20) }, { socStartOfHeat: 99 }),
    ctx()
  );
  assert.equal(r.wantOn, false);
  assert.equal(r.pilot.lastCessionCause, 'hard_buy');
});

test('protection batterie : SoC −20 points depuis l’allumage → coupure (cause battery)', () => {
  const r = pilotStep(
    // ⚠️ Le pilote calcule le SoC du PARC sur batteryEnergyWh/batteryCapacityWh,
    // pas sur batterySocPct : régler le second sans le premier laissait la fixture
    // à 93 % et la protection ne pouvait pas se déclencher. 78 % de 5 360 Wh.
    inp({
      relayOn: true,
      cumulusPowerW: 2900,
      gridPowerW: 10,
      batterySocPct: [78, 78],
      batteryEnergyWh: 0.78 * 5360
    }),
    cfg(),
    st({ onSinceTs: NOON - min(60), lastOnTs: NOON - min(60) }, { socStartOfHeat: 99 }),
    ctx()
  );
  assert.equal(r.wantOn, false);
  assert.equal(r.pilot.lastCessionCause, 'battery');
});

test('protection batterie : plancher 40 % → coupure même sans grosse chute', () => {
  const r = pilotStep(
    inp({
      relayOn: true,
      cumulusPowerW: 2900,
      gridPowerW: 10,
      batterySocPct: [38, 39],
      batteryEnergyWh: 0.38 * 5360
    }),
    cfg(),
    st({ onSinceTs: NOON - min(60), lastOnTs: NOON - min(60) }, { socStartOfHeat: 50 }),
    ctx()
  );
  assert.equal(r.wantOn, false);
  assert.equal(r.pilot.lastCessionCause, 'battery');
});

test('nuage ordinaire : les batteries compensent, achat ≈ 0 → ON NE COUPE PAS', () => {
  const r = pilotStep(
    inp({
      relayOn: true,
      cumulusPowerW: 2900,
      gridPowerW: 25,
      batteryDischargeW: 1200,
      batterySocPct: [95, 96]
    }),
    cfg(),
    st({ onSinceTs: NOON - min(30), lastOnTs: NOON - min(30) }, { socStartOfHeat: 99 }),
    ctx()
  );
  assert.equal(r.wantOn, true);
  assert.equal(r.view.phase, 'chauffe');
});

// ─── Recharge HC nocturne ─────────────────────────────────────────────────────

test('plan HC calculé à 22 h : déficit → départ calé pour finir à 07:15', () => {
  const eveningTs = Date.parse('2026-07-03T20:30:00Z'); // 22:30 locale
  const r = pilotStep(
    inp({ now: eveningTs, gridPowerW: 100, pvApsW: 0 }),
    cfg(),
    st(),
    ctx({ eAvailWh: 2000, hourLocal: 22.5, minuteOfDay: 1350 })
  );
  assert.ok(r.pilot.hcPlan, 'un plan HC doit être calculé');
  assert.equal(r.pilot.hcPlan!.forDate, '2026-07-04');
  assert.ok(r.pilot.hcPlan!.startMin > 6, 'départ après 00:06');
  assert.ok(r.pilot.hcPlan!.startMin < 435, 'départ avant 07:15');
});

test('réserve confortable le soir → PAS de plan HC (rien à recharger)', () => {
  const eveningTs = Date.parse('2026-07-03T20:30:00Z');
  const r = pilotStep(
    inp({ now: eveningTs, gridPowerW: 100, pvApsW: 0 }),
    cfg(),
    st(),
    ctx({ eAvailWh: 15000, hourLocal: 22.5, minuteOfDay: 1350 })
  );
  assert.equal(r.pilot.hcPlan, null);
});

test('modulation météo : J+1 ET J+2 gris → cible augmentée (facteur 1,6)', () => {
  const eveningTs = Date.parse('2026-07-03T20:30:00Z');
  const r = pilotStep(
    inp({ now: eveningTs, gridPowerW: 100, pvApsW: 0, forecastD1Kwh: 3, forecastD2Kwh: 4 }),
    cfg(),
    st(),
    ctx({ eAvailWh: 2000, hourLocal: 22.5, minuteOfDay: 1350 })
  );
  assert.ok(r.pilot.hcPlan);
  assert.equal(r.pilot.hcPlan!.targetWh, Math.round(2 * 2000 * 1.6)); // besoin × hcGrey2Factor
});

test('fenêtre HC active + déficit → wantOn (raison hc)', () => {
  const r = pilotStep(
    inp({ now: NIGHT, isHC: true, gridPowerW: 50, pvApsW: 0 }),
    cfg(),
    st(
      {},
      {
        hcPlan: {
          forDate: '2026-07-03',
          targetWh: 5000,
          minWh: 4000,
          startMin: 230, // 03:50
          endMin: 450,
          reason: 'test',
          computedAt: NIGHT - min(300)
        }
      }
    ),
    ctx({ eAvailWh: 2000, hourLocal: 4, minuteOfDay: 240 })
  );
  assert.equal(r.wantOn, true);
  assert.equal(r.reason, 'hc');
});

test('recharge HC en cours : besoin atteint → coupure (le soleil fera le reste)', () => {
  const r = pilotStep(
    inp({ now: NIGHT, isHC: true, relayOn: true, cumulusPowerW: 2900, gridPowerW: 2900 }),
    cfg(),
    st(
      { onSinceTs: NIGHT - min(45), lastOnTs: NIGHT - min(45) },
      {
        hcPlan: {
          forDate: '2026-07-03',
          targetWh: 5000,
          minWh: 4000,
          startMin: 130,
          endMin: 450,
          reason: 'test',
          computedAt: NIGHT - min(300)
        }
      }
    ),
    ctx({ eAvailWh: 5200, hourLocal: 4, minuteOfDay: 240 })
  );
  assert.equal(r.wantOn, false);
  assert.match(r.view.note, /atteint/);
});

test('recharge HC : SoC ≤ 30 % ET besoin strict atteint → coupure (réserve du matin)', () => {
  const r = pilotStep(
    inp({
      now: NIGHT,
      isHC: true,
      relayOn: true,
      cumulusPowerW: 2900,
      gridPowerW: 600,
      batterySocPct: [28, 29]
    }),
    cfg(),
    st(
      { onSinceTs: NIGHT - min(45), lastOnTs: NIGHT - min(45) },
      {
        hcPlan: {
          forDate: '2026-07-03',
          targetWh: 6000,
          minWh: 4000,
          startMin: 130,
          endMin: 450,
          reason: 'test',
          computedAt: NIGHT - min(300)
        }
      }
    ),
    ctx({ eAvailWh: 4500, hourLocal: 4, minuteOfDay: 240 }) // strict (4000) atteint, cible (6000) non
  );
  assert.equal(r.wantOn, false);
});

// ─── Observation ──────────────────────────────────────────────────────────────

test('observation : conditions réunies → « aurait allumé » journalisé UNE fois, compteur incrémenté', () => {
  const r = pilotStep(
    inp({ gridPowerW: -450 }),
    cfg({ observationMode: true }),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, true); // le pilote VEUT allumer (decide neutralisera)
  assert.ok(r.events.some((e) => e.label === 'aurait allumé'));
  assert.equal(r.pilot.solarStartsToday, 1);
  // Deuxième tick : pas de re-journalisation
  const r2 = pilotStep(
    inp({ now: NOON + min(1), gridPowerW: -450 }),
    cfg({ observationMode: true }),
    st({}, { ...r.pilot }),
    ctx()
  );
  assert.ok(!r2.events.some((e) => e.label === 'aurait allumé'));
  assert.equal(r2.pilot.solarStartsToday, 1);
});

// ─── Modes dégradés ───────────────────────────────────────────────────────────

test('EM50 muet → pas de don franc mesurable → pas d’allumage solaire', () => {
  const r = pilotStep(
    inp({ em50Available: false, gridPowerW: 0 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, false);
});

test('Anker muet : don franc EM50 seul suffit (condition batteries neutralisée)', () => {
  const r = pilotStep(
    inp({ ankerAvailable: false, batterySocPct: [], gridPowerW: -450 }),
    cfg(),
    st({}, { condsSinceTs: NOON - min(4) }),
    ctx()
  );
  assert.equal(r.wantOn, true);
});

test('Anker muet APRÈS 15 h → fenêtre resserrée, pas d’allumage', () => {
  const late = Date.parse('2026-07-03T14:30:00Z'); // 16:30 locale
  const r = pilotStep(
    inp({ now: late, ankerAvailable: false, batterySocPct: [], gridPowerW: -450 }),
    cfg(),
    st({}, { condsSinceTs: late - min(4) }),
    ctx({ hourLocal: 16.5, minuteOfDay: 990 })
  );
  assert.equal(r.wantOn, false);
});

// ─── Bloc « déclencheur de secours » (voie alternative, pas une 8e condition) ────

test('la liste des conditions fait EXACTEMENT 7 lignes (le secours est à part)', () => {
  const r = pilotStep(inp(), cfg(), st(), ctx());
  assert.equal(r.view.conds.length, 7);
  assert.ok(!r.view.conds.some((c) => c.key === 'invisible'));
});

test('secours « en veille (don franc présent) » quand la voie principale exporte', () => {
  const r = pilotStep(inp({ gridPowerW: -450 }), cfg(), st(), ctx());
  assert.equal(r.view.rescue.state, 'standby_export');
});

test('secours « en veille — X W / seuil » quand réseau ≈ 0 et surplus sous le seuil', () => {
  const r = pilotStep(inp({ gridPowerW: -10, pvPowerW: 150 }), cfg(), st(), ctx());
  assert.equal(r.view.rescue.state, 'standby_below');
  assert.match(r.view.rescue.detail, /seuil 2000/);
});

test('secours « ARMÉ » quand les conditions bridage sont réunies', () => {
  const r = pilotStep(
    inp({ gridPowerW: -20, pvPowerW: 150 }),
    cfg(),
    st(),
    ctx({
      potential: {
        potSb1W: 1600,
        potSb2W: 900,
        potTotalW: 3300,
        invisibleSurplusW: 2350,
        geoRatioWest: 0.7,
        calibUpdated: false
      }
    })
  );
  assert.equal(r.view.rescue.state, 'armed');
});

// ─── Alerte « APS muet » ─────────────────────────────────────────────────────

test('APS injoignable + fenêtre ouverte → alerte « unreachable » + secours indisponible + journal', () => {
  const r = pilotStep(inp({ apsAvailable: false, pvApsW: 0 }), cfg(), st(), ctx());
  assert.equal(r.pilot.apsAlert, 'unreachable');
  assert.equal(r.view.apsAlert, 'unreachable');
  assert.equal(r.view.rescue.state, 'unavailable');
  assert.ok(r.events.some((e) => e.label === 'alerte APS'));
});

test('APS injoignable la NUIT → pas d’alerte (fenêtre fermée, extinction normale)', () => {
  const r = pilotStep(
    inp({ now: NIGHT, apsAvailable: false, pvApsW: 0 }),
    cfg(),
    st(),
    ctx({ hourLocal: 4, minuteOfDay: 240 })
  );
  assert.equal(r.pilot.apsAlert, 'none');
});

test('données APS périmées (> apsStaleSec) → « unreachable » même si le bridge répond', () => {
  const r = pilotStep(inp({ apsAvailable: true, apsAgeSec: 900 }), cfg(), st(), ctx());
  assert.equal(r.pilot.apsAlert, 'unreachable');
});

test('panne probable : APS ~0 W pendant que les jumeaux SB1 chargent — armement puis alerte', () => {
  // Batteries PAS pleines (elles chargent) : l'entrée SB1 est significative.
  const covered = inp({
    pvApsW: 10,
    sbInputW: [400, 200],
    batterySocPct: [60, 62],
    batteryChargeW: 800
  });
  // 1er tick : le chrono s'arme, pas encore d'alerte
  const r1 = pilotStep(covered, cfg(), st(), ctx());
  assert.equal(r1.pilot.apsAlert, 'none');
  assert.equal(typeof r1.pilot.apsLowSinceTs, 'number');
  // 2e tick, 11 min plus tard : soutenu > apsMuteConfirmSec → panne probable
  const r2 = pilotStep({ ...covered, now: NOON + min(11) }, cfg(), st({}, { ...r1.pilot }), ctx());
  assert.equal(r2.pilot.apsAlert, 'fault');
  assert.ok(r2.events.some((e) => e.label === 'alerte APS' && /jumeaux/.test(e.detail)));
});

test('CIEL COUVERT : APS bas ET jumeaux SB1 bas → aucune alerte (pas de discriminant)', () => {
  const r = pilotStep(
    inp({ pvApsW: 15, sbInputW: [25, 10], batterySocPct: [60, 62], batteryChargeW: 60 }),
    cfg(),
    st(),
    ctx()
  );
  assert.equal(r.pilot.apsAlert, 'none');
  assert.equal(r.pilot.apsLowSinceTs, null);
});

test('BRIDAGE (batteries pleines) : entrée SB1 non significative → aucune alerte panne', () => {
  const r = pilotStep(
    inp({ pvApsW: 10, sbInputW: [250, 100], batterySocPct: [100, 100], batteryChargeW: 0 }),
    cfg(),
    st(),
    ctx()
  );
  assert.equal(r.pilot.apsAlert, 'none');
  assert.equal(r.pilot.apsLowSinceTs, null);
});

test('résorption : l’APS revient → alerte levée + journal', () => {
  const r = pilotStep(
    inp({ pvApsW: 520, sbInputW: [480, 200] }),
    cfg(),
    st({}, { apsAlert: 'fault', apsLowSinceTs: null }),
    ctx()
  );
  assert.equal(r.pilot.apsAlert, 'none');
  assert.ok(r.events.some((e) => e.label === 'alerte APS levée'));
});

// ─── Horaires de la fenêtre solaire (éphémérides, affichés sur la carte) ────────

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

test('la fenêtre solaire du jour est exposée en horaires HH:MM cohérents (début < fin)', () => {
  const r = pilotStep(inp(), cfg(), st(), ctx());
  assert.ok(r.view.sunWindowStart, 'un horaire de début doit être calculé (été, Sanguinet)');
  assert.ok(r.view.sunWindowEnd, 'un horaire de fin doit être calculé');
  const startMin = hmToMinutes(r.view.sunWindowStart!);
  const endMin = hmToMinutes(r.view.sunWindowEnd!);
  assert.ok(startMin < endMin, 'la fenêtre doit s’ouvrir avant de se fermer');
  // Sanity : cohérent avec les seuils par défaut (élévation/azimut) à cette date/latitude.
  assert.ok(
    startMin >= 11 * 60 && startMin <= 13 * 60,
    `début inattendu : ${r.view.sunWindowStart}`
  );
  assert.ok(endMin >= 16 * 60 && endMin <= 18 * 60, `fin inattendue : ${r.view.sunWindowEnd}`);
});

test('la fenêtre du jour est identique qu’on interroge le pilote de jour ou de nuit (calculée par date)', () => {
  const day = pilotStep(inp(), cfg(), st(), ctx());
  const night = pilotStep(
    inp({ now: NIGHT, gridPowerW: 0 }),
    cfg(),
    st(),
    ctx({ hourLocal: 4, minuteOfDay: 240 })
  );
  assert.equal(day.view.sunWindowStart, night.view.sunWindowStart);
  assert.equal(day.view.sunWindowEnd, night.view.sunWindowEnd);
});

test('la fenêtre est mise en CACHE (pas recalculée) tant que la date ne change pas', () => {
  const r1 = pilotStep(inp(), cfg(), st(), ctx());
  const cached = r1.pilot.sunWindow;
  assert.equal(cached?.forDate, '2026-07-03');
  const r2 = pilotStep(inp({ now: NOON + min(20) }), cfg(), st({}, { ...r1.pilot }), ctx());
  assert.deepEqual(r2.pilot.sunWindow, cached);
});

test('Anker muet : note « resserrée » accompagne les horaires (sans changer la fenêtre affichée)', () => {
  const r = pilotStep(inp({ ankerAvailable: false, batterySocPct: [] }), cfg(), st(), ctx());
  assert.ok(r.view.sunWindowNote.includes('resserrée'));
  assert.ok(r.view.sunWindowStart && r.view.sunWindowEnd);
});

test('fenêtre fermée (avant ouverture) : la prochaine action mentionne l’heure d’ouverture', () => {
  const r = pilotStep(
    inp({ now: NIGHT, gridPowerW: 100, pvApsW: 0 }),
    cfg(),
    st(),
    ctx({ hourLocal: 4, minuteOfDay: 240, eAvailWh: 14000 })
  );
  assert.match(r.view.nextAction, /ouverture prévue \d{2}:\d{2}/);
});

test('protection batterie : le PLANCHER tient même si le parc pondéré est indisponible', () => {
  // Régression : batteryEnergyWh/batteryCapacityWh sont des champs CLOUD. Muets
  // (coupure, panne de pont), socParc valait null et les DEUX gardes batterie
  // devenaient inertes SANS AUCUN SIGNAL — le ballon pouvait vider tout le parc.
  // Repli conservateur : à défaut du parc pondéré, c'est le SoC le PLUS BAS qui
  // décide. Pour une protection, le maillon faible, jamais une moyenne.
  const r = pilotStep(
    inp({
      relayOn: true,
      cumulusPowerW: 2900,
      gridPowerW: 10,
      batterySocPct: [38, 39],
      batteryEnergyWh: 0,
      batteryCapacityWh: 0
    }),
    cfg(),
    st({ onSinceTs: NOON - min(60), lastOnTs: NOON - min(60) }, { socStartOfHeat: 50 }),
    ctx()
  );
  assert.equal(r.wantOn, false);
  assert.equal(r.pilot.lastCessionCause, 'battery');
});

// ─── CRITÈRE DE RECHARGEABILITÉ (31/08/2026) ────────────────────────────────
// Remplace le verrou « APS ≥ 300 W » de la condition « fenêtre solaire ». Ce
// seuil-là était infranchissable pendant les épisodes de surplus : c'est NOTRE
// anti-injection qui plafonne l'onduleur à 30 W, donc le pilote se retrouvait
// aveuglé au moment précis où il y avait quelque chose à récupérer (le 31/08,
// 203 relevés de don franc sur 209 avaient l'APS sous le seuil, pendant que
// 2,1 kWh partaient chez EDF).
//
// La question posée est désormais celle de Laurent : « les batteries pourront-
// elles revenir à 100 % avant la nuit si la chauffe est utilisée ? »

/** Profil maison appris : `meanW` constants sur les 24 heures. */
function profilPlat(meanW: number): HouseProfile {
  return Array.from({ length: 24 }, () => [{ day: '2026-07-02', meanW }]);
}

test('APS bridé à 30 W mais PV à venir abondant → la fenêtre ne bloque plus', () => {
  const r = pilotStep(
    // Don franc, batteries pleines, et un onduleur que NOUS avons plafonné.
    inp({
      gridPowerW: -800,
      pvApsW: 30,
      apsRecoverableW: 750,
      batterySocPct: [100, 100],
      batteryEnergyWh: 5360,
      batteryCapacityWh: 5360,
      solTodayRestKwh: 12
    }),
    cfg(),
    st({}, { houseProfile: profilPlat(300) }),
    ctx()
  );
  const win = r.view.conds.find((c) => c.key === 'window');
  assert.equal(win?.ok, true, `fenêtre refusée : ${win?.detail}`);
  assert.equal(r.energy.rechargeOk, true);
});

test('même situation, mais fin de journée : la marge PV ne couvre plus la chauffe', () => {
  const r = pilotStep(
    inp({
      gridPowerW: -800,
      pvApsW: 30,
      apsRecoverableW: 750,
      batterySocPct: [100, 100],
      batteryEnergyWh: 5360,
      batteryCapacityWh: 5360,
      solTodayRestKwh: 0.3 // 300 Wh : moins que la chauffe + le tampon
    }),
    cfg(),
    st({}, { houseProfile: profilPlat(300) }),
    ctx()
  );
  const win = r.view.conds.find((c) => c.key === 'window');
  assert.equal(win?.ok, false);
  assert.equal(r.energy.rechargeOk, false);
  assert.equal(r.wantOn, false);
});

test('la place à remplir dans le parc est déduite AVANT la chauffe', () => {
  // 4 kWh de PV à venir, 1,2 kWh pour la maison — mais 3 kWh manquent au parc :
  // chauffer maintenant l'empêcherait de finir la journée plein.
  const r = pilotStep(
    inp({
      gridPowerW: -800,
      batterySocPct: [40, 40],
      batteryEnergyWh: 2360,
      batteryCapacityWh: 5360,
      solTodayRestKwh: 4
    }),
    cfg(),
    st({}, { houseProfile: profilPlat(300) }),
    ctx()
  );
  assert.equal(r.energy.rechargeOk, false);
  assert.ok((r.energy.rechargeMarginWh ?? 0) < 3000, 'la place du parc doit amputer la marge');
});

test('météo muette → le critère ne décide pas, il ne bloque pas non plus', () => {
  const r = pilotStep(
    inp({ gridPowerW: -800, forecastAvailable: false, solTodayRestKwh: 0 }),
    cfg(),
    st({}, { houseProfile: profilPlat(300) }),
    ctx()
  );
  assert.equal(r.energy.rechargeOk, null);
  assert.equal(r.energy.rechargeMarginWh, null);
  assert.equal(r.view.conds.find((c) => c.key === 'window')?.ok, true);
});

test('profil maison non appris → même repli prudent (aucun blocage muet)', () => {
  const r = pilotStep(inp({ gridPowerW: -800 }), cfg(), st(), ctx());
  assert.equal(r.energy.rechargeOk, null);
  assert.equal(r.view.conds.find((c) => c.key === 'window')?.ok, true);
});

test('l’APS récupérable compte dans le surplus réorientable', () => {
  const sans = pilotStep(
    inp({ gridPowerW: -700, maxAcAvailable: true, maxAcChargeW: 0, maxAcNetW: 0 }),
    cfg(),
    st(),
    ctx()
  );
  const avec = pilotStep(
    inp({
      gridPowerW: -700,
      apsRecoverableW: 750,
      maxAcAvailable: true,
      maxAcChargeW: 0,
      maxAcNetW: 0
    }),
    cfg(),
    st(),
    ctx()
  );
  assert.equal(avec.view.surplusW - sans.view.surplusW, 750);
  assert.match(avec.view.conds.find((c) => c.key === 'surplus')?.detail ?? '', /750 W/);
});

test('don franc + journée rechargeable : le ballon peut aller jusqu’au plein', () => {
  // 97 % rempli — au-dessus du seuil anti-cyclage de 95 %. Le 31/08 c'est cet
  // état qui refusait les 500 Wh de place restants pendant que 2,1 kWh partaient
  // au réseau.
  const presquePlein = ctx({ eAvailWh: 15_520, eFullWh: 16_000 });
  const bloque = pilotStep(
    inp({ gridPowerW: -50 }), // pas de don franc → seuil 95 % maintenu
    cfg(),
    st({}, { houseProfile: profilPlat(300) }),
    presquePlein
  );
  const libre = pilotStep(
    inp({
      gridPowerW: -800, // don franc
      batterySocPct: [100, 100],
      batteryEnergyWh: 5360,
      batteryCapacityWh: 5360,
      solTodayRestKwh: 12
    }),
    cfg(),
    st({}, { houseProfile: profilPlat(300) }),
    presquePlein
  );
  assert.equal(bloque.view.conds.find((c) => c.key === 'tank')?.ok, false);
  assert.equal(libre.view.conds.find((c) => c.key === 'tank')?.ok, true);
});

test('le soir, le critère ne crédite PAS le soleil de demain', () => {
  // Constaté en service le 31/08 à 20 h : `solNextDaylightKwh` bascule sur la
  // journée du lendemain à 19 h (c'est voulu pour la recharge HC), et la marge
  // affichait 12 660 Wh nuit tombée. Le critère doit lire le reste d'AUJOURD'HUI.
  const soir = Date.parse('2026-07-03T17:30:00Z'); // 19:30 locale
  const r = pilotStep(
    inp({ now: soir, gridPowerW: -800, solNextDaylightKwh: 18, solTodayRestKwh: 0 }),
    cfg(),
    st({}, { houseProfile: profilPlat(300) }),
    ctx({ hourLocal: 19.5, minuteOfDay: 19 * 60 + 30 })
  );
  assert.equal(r.energy.rechargeOk, false);
  assert.ok(
    (r.energy.rechargeMarginWh ?? 0) <= 0,
    `marge = ${r.energy.rechargeMarginWh} Wh alors que la journée est finie`
  );
});
