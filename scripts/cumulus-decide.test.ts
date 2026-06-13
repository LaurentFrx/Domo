/**
 * Tests unitaires du moteur de décision cumulus (decide() — pur).
 *
 * Sans dépendance : runner intégré node:test + effacement de types natif.
 *   pnpm test:cumulus
 *   # ou : node --experimental-strip-types --test scripts/cumulus-decide.test.ts
 *
 * Placé hors de src/ et tests/ pour éviter le conflit d'extension `.ts` avec
 * svelte-check (résolution bundler) ; Node ESM exige l'extension explicite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/lib/server/cumulus/decide.ts';
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
    comfortHysteresisC: 4,
    rechargeHysteresisC: 5,
    tempOffsetC: 0,
    surplusOnW: 1800,
    surplusOffW: 0,
    surplusOffGraceSec: 90,
    minOnSec: 300,
    minOffSec: 300,
    antiCyclingSec: 600,
    forecastFaibleKwh: 7,
    autoOffDelaySec: 600,
    tempStaleSec: 1800,
    tankFullPowerW: 250,
    tankFullConfirmSec: 120,
    faultConfirmSec: 300,
    ...o
  };
}

function st(o: Partial<CumulusRuntimeState> = {}): CumulusRuntimeState {
  return {
    autoMode: 'auto',
    manualRelayOn: false,
    relayDesired: null,
    lastOnTs: null,
    lastOffTs: null,
    lastTransitionTs: null,
    surplusBelowSinceTs: null,
    lowPowerSinceTs: null,
    ballonCharged: false,
    chargedAtTempC: null,
    onSinceTs: null,
    energyDayDate: '2023-11-14',
    energyTodayKwh: 0,
    lastCumulusKwh: null,
    lastDisinfectTs: NOW,
    lastTickTs: null,
    lastReason: 'idle',
    lastSubMode: 'OFF',
    anomaly: 'none',
    log: [],
    ...o
  };
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
    forecastAvailable: true,
    solNextDaylightKwh: 20,
    relayAvailable: true,
    relayOn: false,
    ...o
  };
}

// ── Priorités hautes ──
test('sécurité haute : T ≥ Tmax → OFF', () => {
  const d = decide(
    inp({ tempC: 73, relayOn: true }),
    cfg(),
    st({ onSinceTs: NOW - min(10), lastOnTs: NOW - min(10) })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'safety_high');
});

test('confort : T < Tmin → ON même en HP sans surplus', () => {
  const d = decide(inp({ tempC: 40, isHC: false, gridPowerW: 500 }), cfg(), st());
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'comfort_min');
});

test('confort bypasse l’anti-court-cycle', () => {
  const d = decide(
    inp({ tempC: 40, relayOn: false }),
    cfg(),
    st({ lastOffTs: NOW - 10_000, lastTransitionTs: NOW - 10_000 })
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'comfort_min');
});

// ── Solaire ──
test('solaire : surplus ≥ on → ON (aucune cible de température)', () => {
  const d = decide(inp({ tempC: 50, gridPowerW: -2000, relayOn: false }), cfg(), st());
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'solar');
  assert.equal(d.surplusW, 2000);
});

test('pas de cible : chauffe maintenue à T haute tant que le cumulus n’a pas coupé', () => {
  // T=60 mais la résistance tire encore (conso 2900) → on NE coupe PAS sur la température
  const d = decide(
    inp({ tempC: 60, relayOn: true, cumulusPowerW: 2900, gridPowerW: -1000 }),
    cfg(),
    st({ onSinceTs: NOW - min(5), lastOnTs: NOW - min(5) })
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'solar');
});

test('surplus reconstitué : maintien ON pendant la chauffe (import < conso résistance)', () => {
  // relais ON, résistance 2900 W, import 900 W → surplus reconstitué 2000 ≥ off
  const d = decide(
    inp({ tempC: 55, relayOn: true, cumulusPowerW: 2900, gridPowerW: 900 }),
    cfg(),
    st({ onSinceTs: NOW - min(5), lastOnTs: NOW - min(5) })
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'solar');
  assert.equal(d.surplusW, 2000);
});

test('grâce anti-nuage expirée → coupe la chauffe solaire', () => {
  // surplus reconstitué négatif depuis 100 s (> grâce 90 s) → plus de maintien
  const d = decide(
    inp({ tempC: 55, isHC: false, relayOn: true, cumulusPowerW: 2900, gridPowerW: 3000 }),
    cfg(),
    st({
      onSinceTs: NOW - min(10),
      lastOnTs: NOW - min(10),
      lastTransitionTs: NOW - min(10),
      surplusBelowSinceTs: NOW - 100_000
    })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'idle');
});

// ── Heures creuses modulées météo ──
test('HC + beau temps prévu → AUCUNE chauffe nocturne (cas été / solstice)', () => {
  // eau tiède (48°C > confort 45) mais grand soleil prévu demain → on laisse le PV de demain
  const d = decide(inp({ tempC: 48, isHC: true, solNextDaylightKwh: 25 }), cfg(), st());
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'idle');
});

test('HC + peu de soleil prévu → chauffe renfort', () => {
  const d = decide(inp({ tempC: 52, isHC: true, solNextDaylightKwh: 3 }), cfg(), st());
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'offpeak_boost');
});

test('HC + peu de soleil mais ballon déjà plein → veille', () => {
  // pas de cible : ce qui bloque la chauffe, c'est « ballon plein » (le cumulus a coupé), pas la T
  const d = decide(
    inp({ tempC: 58, isHC: true, solNextDaylightKwh: 3 }),
    cfg(),
    st({ ballonCharged: true, chargedAtTempC: 61 })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'idle');
});

test('forecast indisponible → pas de chauffe HC (confort mini reste le seul filet)', () => {
  const d = decide(
    inp({ tempC: 52, isHC: true, forecastAvailable: false, solNextDaylightKwh: 0 }),
    cfg(),
    st()
  );
  assert.equal(d.relayDesired, false);
});

// ── Replis ──
test('sonde périmée + surplus → ON solaire (repli) + anomalie', () => {
  const d = decide(inp({ tempC: null, gridPowerW: -2000, relayOn: false }), cfg(), st());
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'solar');
  assert.equal(d.anomaly, 'sensor_stale');
});

test('EM-50 absent → surplus ignoré, mais HC opérant si peu de soleil prévu', () => {
  const a = decide(
    inp({ tempC: 48, em50Available: false, isHC: true, solNextDaylightKwh: 3 }),
    cfg(),
    st()
  );
  assert.equal(a.reason, 'offpeak_boost');
  const b = decide(
    inp({ tempC: 48, em50Available: false, isHC: false, gridPowerW: -3000 }),
    cfg(),
    st()
  );
  assert.equal(b.relayDesired, false); // pas de solaire sans mesure
});

test('relais injoignable → cold_start, aucun ordre', () => {
  const d = decide(inp({ relayAvailable: false, relayOn: null }), cfg(), st());
  assert.equal(d.apply, false);
  assert.equal(d.reason, 'cold_start');
  assert.equal(d.anomaly, 'relay_unreachable');
});

// ── Anti-court-cycle ──
test('anti-court-cycle : OFF récent bloque le ON solaire', () => {
  const d = decide(
    inp({ tempC: 50, gridPowerW: -2000, relayOn: false }),
    cfg(),
    st({ lastOffTs: NOW - 100_000, lastTransitionTs: NOW - 100_000 })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'anticycle_hold');
});

test('durée min ON : ON récent bloque la coupure', () => {
  const d = decide(
    inp({ tempC: 55, isHC: false, relayOn: true, cumulusPowerW: 2900, gridPowerW: 3000 }),
    cfg(),
    st({
      lastOnTs: NOW - 100_000,
      lastTransitionTs: NOW - 100_000,
      onSinceTs: NOW - 100_000,
      surplusBelowSinceTs: NOW - 100_000
    })
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'anticycle_hold');
});

// ── Détection conso ──
test('ballon plein : conso nulle + eau chaude → OFF tank_full + chargé', () => {
  // relais ON depuis 6 min (> minOn 300 s) : la coupure n'est pas bloquée par l'anti-cycle
  const d = decide(
    inp({ tempC: 58, relayOn: true, cumulusPowerW: 5 }),
    cfg(),
    st({ onSinceTs: NOW - min(6), lowPowerSinceTs: NOW - min(6), lastOnTs: NOW - min(6) })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'tank_full');
  assert.equal(d.nextState.ballonCharged, true);
});

test('panne résistance : conso nulle + eau froide longtemps → heater_fault', () => {
  const d = decide(
    inp({ tempC: 30, relayOn: true, cumulusPowerW: 0 }),
    cfg(),
    st({ onSinceTs: NOW - min(6), lowPowerSinceTs: NOW - min(6), lastOnTs: NOW - min(6) })
  );
  assert.equal(d.anomaly, 'heater_fault');
  assert.equal(d.relayDesired, false);
});

// ── Modes utilisateur ──
test('manuel ON', () => {
  const d = decide(
    inp({ tempC: 50, relayOn: false }),
    cfg(),
    st({ autoMode: 'manual', manualRelayOn: true })
  );
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'manual_on');
});

test('manuel ON mais sécurité haute prime', () => {
  const d = decide(
    inp({ tempC: 73, relayOn: true }),
    cfg(),
    st({ autoMode: 'manual', manualRelayOn: true })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'safety_high');
});

test('vacances → OFF forcé', () => {
  const d = decide(inp({ tempC: 40, relayOn: true }), cfg(), st({ autoMode: 'off' }));
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'vacation_off');
});

// ── Énergie & charge ──
test('énergie du jour : delta du compteur cumulatif', () => {
  const d = decide(inp({ cumulusKwh: 105 }), cfg(), st({ lastCumulusKwh: 104, energyTodayKwh: 1 }));
  assert.equal(d.nextState.energyTodayKwh, 2);
});

test('changement de jour → énergie remise à zéro', () => {
  const d = decide(
    inp({ todayParis: '2023-11-15', cumulusKwh: 200 }),
    cfg(),
    st({ energyDayDate: '2023-11-14', energyTodayKwh: 5, lastCumulusKwh: 199 })
  );
  assert.equal(d.nextState.energyTodayKwh, 0);
  assert.equal(d.nextState.energyDayDate, '2023-11-15');
});

test('ballon chargé bloque le solaire', () => {
  const d = decide(
    inp({ tempC: 55, gridPowerW: -2500, relayOn: false }),
    cfg(),
    st({ ballonCharged: true, chargedAtTempC: 58 })
  );
  assert.equal(d.relayDesired, false);
});

test('ballon chargé invalidé après refroidissement → solaire ré-autorisé', () => {
  const d = decide(
    inp({ tempC: 53, gridPowerW: -2500, relayOn: false }),
    cfg(),
    st({ ballonCharged: true, chargedAtTempC: 58 })
  );
  assert.equal(d.nextState.ballonCharged, false);
  assert.equal(d.relayDesired, true);
  assert.equal(d.reason, 'solar');
});

// ── Désinfection (pas de cycle forcé : sous-produit des chauffes complètes) ──
test('cumulus coupe à sa consigne (eau ≥60°C) → ballon plein + désinfection tracée', () => {
  // conso nulle relais ON depuis longtemps = le cumulus a coupé ; eau 62°C ≥ 60 → désinfecté
  const d = decide(
    inp({ tempC: 62, relayOn: true, cumulusPowerW: 5 }),
    cfg(),
    st({
      onSinceTs: NOW - min(6),
      lowPowerSinceTs: NOW - min(6),
      lastOnTs: NOW - min(6),
      lastDisinfectTs: null
    })
  );
  assert.equal(d.reason, 'tank_full');
  assert.equal(d.nextState.lastDisinfectTs, NOW);
});

test('sonde ≥60°C → désinfection tracée (sans cycle forcé)', () => {
  const d = decide(inp({ tempC: 61 }), cfg(), st({ lastDisinfectTs: null }));
  assert.equal(d.nextState.lastDisinfectTs, NOW);
});

test('aucune branche « légionellose » : beau temps + eau tiède la nuit → veille', () => {
  const d = decide(
    inp({ tempC: 48, isHC: true, solNextDaylightKwh: 25 }),
    cfg(),
    st({ lastDisinfectTs: null })
  );
  assert.equal(d.relayDesired, false);
  assert.equal(d.reason, 'idle');
});
