/**
 * Tests du moteur de décision decide() — V2 (protections + overrides + délégation
 * au pilote). La logique de chauffe vit dans pilot.ts (voir cumulus-pilot.test.ts).
 *   pnpm test:cumulus
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type PilotWant } from '../src/lib/server/cumulus/decide.ts';
import type {
  CumulusInputs,
  CumulusConfig,
  CumulusRuntimeState
} from '../src/lib/server/cumulus/types.ts';

const NOW = 1_700_000_000_000;
const min = (m: number) => m * 60_000;

function cfg(o: Partial<CumulusConfig> = {}): CumulusConfig {
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
    ...o
  } as CumulusConfig;
}

function st(o: Partial<CumulusRuntimeState> = {}): CumulusRuntimeState {
  return {
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
    energyDayDate: '2023-11-14',
    energyTodayKwh: 0,
    lastCumulusKwh: null,
    lastDisinfectTs: NOW,
    lastTickTs: null,
    lastTempC: 50,
    lastReason: 'idle',
    lastSubMode: 'OFF',
    anomaly: 'none',
    log: [],
    ...o
  } as CumulusRuntimeState;
}

function inp(o: Partial<CumulusInputs> = {}): CumulusInputs {
  return {
    now: NOW,
    todayParis: '2023-11-14',
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
    forecastD1Kwh: 18,
    forecastD2Kwh: 18,
    relayAvailable: true,
    relayOn: false,
    ankerAvailable: true,
    pvPowerW: 0,
    ankerGridPowerW: 0,
    sbOutputPowerW: 0,
    batteryDischargeW: 0,
    batterySocPct: [],
    batteryEnergyWh: 0,
    batteryCapacityWh: 0,
    batteryChargeW: 0,
    sbInputW: [],
    pvApsW: 0,
    indoorC: null,
    outdoorC: null,
    indoorSources: [],
    outdoorSources: [],
    appliances: [],
    ...o
  } as CumulusInputs;
}

const wantSolar: PilotWant = { wantOn: true, reason: 'solar', note: 'don franc 450 W' };
const wantHc: PilotWant = { wantOn: true, reason: 'hc', note: 'recharge de nuit' };
const wantWait: PilotWant = { wantOn: false, reason: 'wait', note: 'surveillance' };

// ─── Overrides & protections ─────────────────────────────────────────────────

test('sécurité haute : T ≥ Tmax → OFF, même si le pilote veut chauffer', () => {
  const d = decide(
    inp({ tempC: 73, relayOn: true }),
    cfg(),
    st({ onSinceTs: NOW - min(10), lastOnTs: NOW - min(10) }),
    wantSolar
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'safety_high');
});

test('manuel prime sur le pilote', () => {
  const d = decide(
    inp({ relayOn: true }),
    cfg(),
    st({ autoMode: 'manual', manualRelayOn: true }),
    wantWait
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'manual_on');
});

test('vacances : tout coupé, même si le pilote veut chauffer', () => {
  const d = decide(inp(), cfg(), st({ autoMode: 'off' }), wantSolar);
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'vacation_off');
});

test('tank_full : conso nulle relais ON confirmée → ballon plein, prime sur le pilote', () => {
  const d = decide(
    inp({ tempC: 58, relayOn: true, cumulusPowerW: 5 }),
    cfg(),
    st({ onSinceTs: NOW - min(6), lowPowerSinceTs: NOW - min(6), lastOnTs: NOW - min(6) }),
    wantSolar
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'tank_full');
  assert.equal(d.nextState.ballonCharged, true);
});

test('boost « Chauffer maintenant » : ON quel que soit le pilote', () => {
  const d = decide(inp(), cfg(), st({ boostUntilFull: true }), wantWait);
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'boost');
});

test('relais injoignable → cold_start, aucun ordre', () => {
  const d = decide(inp({ relayAvailable: false, relayOn: null }), cfg(), st(), wantSolar);
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'cold_start');
  assert.equal(d.anomaly, 'relay_unreachable');
});

// ─── Délégation au pilote ─────────────────────────────────────────────────────

test('pilote veut chauffer (solaire) → pilot_solar ON', () => {
  const d = decide(inp(), cfg(), st(), wantSolar);
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'pilot_solar');
  assert.equal(d.subMode, 'PV');
});

test('pilote veut recharger (HC) → pilot_hc ON', () => {
  const d = decide(inp({ isHC: true }), cfg(), st(), wantHc);
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'pilot_hc');
  assert.equal(d.subMode, 'HC');
});

test('pilote attend → pilot_wait OFF', () => {
  const d = decide(inp(), cfg(), st(), wantWait);
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'pilot_wait');
});

test('pilote absent → idle OFF (veille sûre)', () => {
  const d = decide(inp(), cfg(), st());
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'idle');
});

// ─── Observation ──────────────────────────────────────────────────────────────

test('OBSERVATION : le pilote veut chauffer → observe_only, relais NON commandé', () => {
  const d = decide(inp(), cfg({ observationMode: true }), st(), wantSolar);
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'observe_only');
  assert.match(d.note, /aurait allumé/);
});

test('OBSERVATION : le manuel reste opérant', () => {
  const d = decide(
    inp({ relayOn: false }),
    cfg({ observationMode: true }),
    st({ autoMode: 'manual', manualRelayOn: true }),
    wantWait
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'manual_on');
});

// ─── Anti-court-cycle ─────────────────────────────────────────────────────────

test('anti-court-cycle : pilote veut ON juste après un OFF → anticycle_hold', () => {
  const d = decide(
    inp({ relayOn: false }),
    cfg(),
    st({ lastOffTs: NOW - min(2), lastTransitionTs: NOW - min(2) }),
    wantSolar
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'anticycle_hold');
});

test('anti-court-cycle : pilote veut OFF avant minOn écoulé → maintien ON', () => {
  const d = decide(
    inp({ relayOn: true, cumulusPowerW: 2900 }),
    cfg(),
    st({ onSinceTs: NOW - min(2), lastOnTs: NOW - min(2) }),
    wantWait
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'anticycle_hold');
});

// ─── Comptabilité conservée ───────────────────────────────────────────────────

test('hystérésis de recharge : la sonde rebaisse de 5°C sous la charge → ballonCharged levé', () => {
  const d = decide(
    inp({ tempC: 55 }),
    cfg(),
    st({ ballonCharged: true, chargedAtTempC: 61 }),
    wantWait
  );
  assert.equal(d.nextState.ballonCharged, false);
});

test('désinfection tracée dès 60°C', () => {
  const d = decide(inp({ tempC: 61 }), cfg(), st({ lastDisinfectTs: null }), wantWait);
  assert.equal(d.nextState.lastDisinfectTs, NOW);
});

// ─── VETO ABSOLU DE SOUTIRAGE — règle 1, tous modes confondus ────────────
// « ON NE DOIT JAMAIS POMPER SUR LE RÉSEAU EDF. » Mesuré sur 30 jours :
// manual_on et boost portaient 86 % des achats EDF du cumulus (1 491 Wh sur
// 1 727) parce qu'ils posaient bypass = true sans jamais regarder le compteur.

test('VETO : le BOOST ne chauffe plus sur EDF', () => {
  const d = decide(
    inp({ gridPowerW: 800, cumulusPowerW: 2950 }),
    cfg(),
    st({ boostUntilFull: true, relayOn: true, onSinceTs: NOW - min(20) })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'grid_veto');
});

test('VETO : le mode MANUEL ne chauffe plus sur EDF', () => {
  const d = decide(
    inp({ gridPowerW: 800, cumulusPowerW: 2950 }),
    cfg(),
    st({ autoMode: 'manual', manualRelayOn: true, relayOn: true, onSinceTs: NOW - min(20) })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'grid_veto');
});

test('VETO : il FRANCHIT l’anti-court-cycle (2,9 kW sur EDF ne se négocie pas)', () => {
  const d = decide(
    inp({ gridPowerW: 900, cumulusPowerW: 2950 }),
    cfg(),
    // allumé il y a 10 s : minOnSec bloquerait normalement toute coupure
    st({
      boostUntilFull: true,
      relayOn: true,
      onSinceTs: NOW - 10_000,
      lastTransitionTs: NOW - 10_000
    })
  );
  assert.equal(d.relayDesired, false, 'la coupure doit passer malgré minOnSec');
});

test('VETO : sous le seuil d’achat franc, le boost continue normalement', () => {
  const d = decide(
    inp({ gridPowerW: 120, cumulusPowerW: 2950 }),
    cfg(),
    st({ boostUntilFull: true, relayOn: true, onSinceTs: NOW - min(20) })
  );
  assert.equal(d.reason, 'boost');
  assert.equal(d.relayDesired, true);
});

test('VETO : compteur muet → on ne coupe pas à l’aveugle', () => {
  const d = decide(
    inp({ em50Available: false, gridPowerW: 900, cumulusPowerW: 2950 }),
    cfg(),
    st({ boostUntilFull: true, relayOn: true, onSinceTs: NOW - min(20) })
  );
  assert.notEqual(d.reason, 'grid_veto');
});
