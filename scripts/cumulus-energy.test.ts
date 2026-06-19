/**
 * Tests unitaires du modèle d'énergie ballon (updateEnergyModel — PUR).
 *
 *   pnpm test:energy
 *   # ou : node --experimental-strip-types --test scripts/cumulus-energy.test.ts
 *
 * Placé hors de src/ (comme cumulus-decide.test.ts) pour éviter le conflit
 * d'extension `.ts` avec svelte-check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateEnergyModel, averageTemp } from '../src/lib/server/cumulus/energy-model.ts';
import type {
  CumulusInputs,
  CumulusConfig,
  CumulusRuntimeState,
  EnergyModelConfig,
  EnergyState
} from '../src/lib/server/cumulus/types.ts';

const NOW = 1_700_000_000_000;
const hours = (h: number) => h * 3_600_000;

function energyModel(o: Partial<EnergyModelConfig> = {}): EnergyModelConfig {
  return {
    etaHeat: 0.98,
    tankWhPerC: 348,
    setpointC: 59,
    inletSummerC: 15,
    inletWinterC: 9,
    outdoorWinterC: 5,
    outdoorSummerC: 25,
    outdoorFallbackC: 18,
    roomOffsetSummerC: 1,
    roomOffsetWinterC: -2,
    roomFallbackC: 20,
    lossCoeffWhPerCh: 2.8,
    eDoucheWhSummer: 2000,
    eDoucheWhWinter: 2800,
    drawDropThresholdC: 2.0,
    drawWindowMin: 20,
    probeFullRestC: 55,
    indoorTopics: ['zigbee2mqtt/Thermo SdB', 'zigbee2mqtt/Thermo Salon'],
    outdoorSources: { daikin: true, thermoExtTopic: 'zigbee2mqtt/Thermo_ext', forecast: true },
    ...o
  };
}

function cfg(em: Partial<EnergyModelConfig> = {}): CumulusConfig {
  // Seul energyModel est lu par updateEnergyModel ; le reste est du remplissage.
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
    observationMode: true,
    batteryMaxDischargeW: 2400,
    energyModel: energyModel(em)
  };
}

function energyState(o: Partial<EnergyState> = {}): EnergyState {
  return {
    eAvailWh: 0,
    lastUpdateTs: null,
    lastProbeC: null,
    lastProbeTs: null,
    lastAnchorTs: null,
    dayDate: '2023-11-14',
    injWhDay: 0,
    lossWhDay: 0,
    drawWhDay: 0,
    drawEvents: 0,
    wasFull: false,
    drawRefC: null,
    drawRefTs: null,
    tRoomC: null,
    tExtC: null,
    ...o
  };
}

function st(
  energy: Partial<EnergyState> = {},
  o: Partial<CumulusRuntimeState> = {}
): CumulusRuntimeState {
  return {
    autoMode: 'auto',
    manualRelayOn: false,
    boostUntilFull: false,
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
    lastDisinfectTs: null,
    lastTickTs: null,
    lastTempC: null,
    lastReason: 'idle',
    lastSubMode: 'OFF',
    anomaly: 'none',
    energy: energyState(energy),
    log: [],
    ...o
  };
}

function inp(o: Partial<CumulusInputs> = {}): CumulusInputs {
  return {
    now: NOW,
    todayParis: '2023-11-14',
    tempC: 45,
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
    ankerAvailable: true,
    pvPowerW: 0,
    ankerGridPowerW: 0,
    sbOutputPowerW: 0,
    batteryDischargeW: 0,
    batterySocPct: [],
    indoorC: 23,
    outdoorC: 25, // été plein → tInlet = inletSummer (15), eFull = 348*44 = 15312
    indoorSources: [{ name: 'SdB', tempC: 23 }],
    outdoorSources: [{ name: 'météo', tempC: 25 }],
    ...o
  };
}

const E_FULL = 348 * (59 - 15); // 15312 Wh à outdoorC=25

// ── Initialisation ──
test('init : 1er tick → estimation BASSE depuis la sonde (tankWhPerC·(probe−inlet))', () => {
  const { energy, result } = updateEnergyModel(
    inp({ tempC: 40 }),
    cfg(),
    st({ lastUpdateTs: null, eAvailWh: 0 })
  );
  assert.equal(energy.eAvailWh, 348 * (40 - 15)); // 8700
  assert.equal(result.eFullWh, E_FULL);
  assert.equal(result.anchored, false);
});

// ── Bilan continu ──
test('injection : chauffe en cours → E_avail augmente', () => {
  const { energy } = updateEnergyModel(
    inp({ tempC: 45, relayOn: true, cumulusPowerW: 3000 }),
    cfg(),
    st({ lastUpdateTs: NOW - 60_000, eAvailWh: 5000, lastProbeC: 45, lastProbeTs: NOW - 60_000 })
  );
  // inj ≈ 0,98·3000·(1/60)h ≈ 49 Wh ; pertes négligeables
  assert.ok(energy.eAvailWh > 5040 && energy.eAvailWh < 5060, `eAvail=${energy.eAvailWh}`);
});

test('pertes : au repos → E_avail diminue (Δt plafonné à 5 min)', () => {
  const { energy } = updateEnergyModel(
    inp({ tempC: 50, relayOn: false, cumulusPowerW: 0 }),
    cfg(),
    st({
      lastUpdateTs: NOW - hours(2),
      eAvailWh: 10000,
      lastProbeC: 50,
      lastProbeTs: NOW - hours(2)
    })
  );
  // Trou de 2 h mais Δt borné à 5 min → perte de quelques Wh seulement, pas un effondrement
  assert.ok(energy.eAvailWh < 10000 && energy.eAvailWh > 9990, `eAvail=${energy.eAvailWh}`);
});

// ── Recalage (vérité primaire) ──
test('anchor : ballon plein (decide a posé ballonCharged) → E_avail = E_full', () => {
  const { energy, result } = updateEnergyModel(
    inp({ tempC: 58, relayOn: false }),
    cfg(),
    st({ lastUpdateTs: NOW - 60_000, eAvailWh: 3000 }, { ballonCharged: true })
  );
  assert.equal(energy.eAvailWh, E_FULL);
  assert.equal(result.anchored, true);
  assert.equal(energy.lastAnchorTs, NOW);
});

test('anchor : sonde chaude au repos (≥ probeFullRestC) → E_avail = E_full', () => {
  const { energy, result } = updateEnergyModel(
    inp({ tempC: 56, relayOn: false }),
    cfg(),
    st({ lastUpdateTs: NOW - 60_000, eAvailWh: 4000 })
  );
  assert.equal(energy.eAvailWh, E_FULL);
  assert.equal(result.anchored, true);
});

test('anchor : « dernier plein » figé tant que le ballon RESTE plein (front montant)', () => {
  // 1er tick plein → horodatage posé
  const a = updateEnergyModel(
    inp({ tempC: 58, relayOn: false }),
    cfg(),
    st({ lastUpdateTs: NOW - 60_000, eAvailWh: 3000 }, { ballonCharged: true })
  );
  assert.equal(a.energy.lastAnchorTs, NOW);
  assert.equal(a.energy.wasFull, true);
  // tick suivant, 1 h plus tard, toujours plein → lastAnchorTs NE bouge PAS
  const NOW2 = NOW + hours(1);
  const b = updateEnergyModel(
    inp({ now: NOW2, tempC: 58, relayOn: false }),
    cfg(),
    st(
      { lastUpdateTs: NOW, eAvailWh: a.energy.eAvailWh, lastAnchorTs: NOW, wasFull: true },
      { ballonCharged: true }
    )
  );
  assert.equal(b.energy.lastAnchorTs, NOW); // figé au moment où il est devenu plein
});

// ── Puisage (détection par FENÊTRE GLISSANTE, 1c) ──
test('puisage : marche −6°C sur la fenêtre → détecté + E_avail décrémenté', () => {
  const { energy, result } = updateEnergyModel(
    inp({ tempC: 42, relayOn: false }),
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 10000,
      lastProbeC: 48,
      lastProbeTs: NOW - 60_000,
      drawRefC: 48,
      drawRefTs: NOW - hours(1) // référence d'il y a 1 h (> fenêtre 20 min)
    })
  );
  assert.ok(result.drawEvent !== null, 'événement attendu');
  assert.equal(result.drawEvent?.dropC, 6);
  assert.equal(energy.drawEvents, 1);
  assert.ok(result.drawEvent!.eDrawnWh > 1800, `eDrawn=${result.drawEvent?.eDrawnWh}`);
  assert.ok(energy.eAvailWh < 8200, `eAvail=${energy.eAvailWh}`); // ~−2000
});

test('déclin lent (pertes seules) sur la fenêtre → AUCUN faux positif', () => {
  const { result } = updateEnergyModel(
    inp({ tempC: 49.5, relayOn: false }), // −0,5°C en 2 h = pertes
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 10000,
      lastProbeC: 50,
      drawRefC: 50,
      drawRefTs: NOW - hours(2)
    })
  );
  assert.equal(result.drawEvent, null);
});

test('sonde qui remonte → pas de puisage (référence rebasée sur le point haut)', () => {
  const { result, energy } = updateEnergyModel(
    inp({ tempC: 52, relayOn: false }),
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 9000,
      lastProbeC: 50,
      drawRefC: 50,
      drawRefTs: NOW - hours(1)
    })
  );
  assert.equal(result.drawEvent, null);
  assert.equal(energy.drawRefC, 52);
});

test('garde relais LEVÉ : un tirage est détecté même relais ON', () => {
  const { result } = updateEnergyModel(
    inp({ tempC: 42, relayOn: true, cumulusPowerW: 3000 }),
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 10000,
      lastProbeC: 48,
      drawRefC: 48,
      drawRefTs: NOW - hours(1)
    })
  );
  assert.ok(result.drawEvent !== null); // plus de masquage par relayOn
});

test('masquage anchor LEVÉ : tirage à ≥55°C journalisé, mais E_avail re-ancré à plein', () => {
  const { energy, result } = updateEnergyModel(
    inp({ tempC: 56, relayOn: false }), // ≥55 → restHot
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 12000,
      lastProbeC: 59,
      drawRefC: 59,
      drawRefTs: NOW - hours(1)
    })
  );
  assert.ok(result.drawEvent !== null, 'tirage journalisé (masquage levé)');
  assert.equal(energy.drawEvents, 1);
  assert.equal(result.anchored, true);
  assert.equal(energy.eAvailWh, E_FULL); // anchor sur la valeur absolue → plein
});

// ── Bornes ──
test('clamp bas : gros tirage sur ballon presque vide → E_avail = 0 (jamais négatif)', () => {
  const { energy } = updateEnergyModel(
    inp({ tempC: 40, relayOn: false }),
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 1000,
      lastProbeC: 50,
      drawRefC: 50,
      drawRefTs: NOW - hours(1)
    })
  );
  assert.equal(energy.eAvailWh, 0);
});

test('clamp haut : injection sur ballon plein → saturé à E_full (clamp engagé)', () => {
  const { energy } = updateEnergyModel(
    inp({ tempC: 50, relayOn: true, cumulusPowerW: 3000 }),
    cfg(),
    st({ lastUpdateTs: NOW - 60_000, eAvailWh: E_FULL, lastProbeC: 50, lastProbeTs: NOW - 60_000 })
  );
  // E_FULL + injection − pertes dépasserait E_FULL → ramené EXACTEMENT à E_FULL
  assert.equal(energy.eAvailWh, E_FULL);
});

// ── Bascule de jour ──
test('bascule de jour → composantes du jour remises à zéro', () => {
  const { energy } = updateEnergyModel(
    inp({ todayParis: '2023-11-15', tempC: 50, relayOn: false }),
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 8000,
      lastProbeC: 50,
      lastProbeTs: NOW - 60_000,
      dayDate: '2023-11-14',
      injWhDay: 999,
      lossWhDay: 999,
      drawWhDay: 999,
      drawEvents: 5
    })
  );
  assert.equal(energy.dayDate, '2023-11-15');
  assert.ok(energy.injWhDay < 10);
  assert.ok(energy.drawWhDay < 10);
  assert.equal(energy.drawEvents, 0);
});

// ── Δt borné (immunité ticks sautés) ──
test('Δt borné : long trou (Domo redémarré) → pertes plafonnées (pas d’effondrement)', () => {
  const { energy } = updateEnergyModel(
    inp({ tempC: 50, relayOn: false }),
    cfg(),
    st({
      lastUpdateTs: NOW - hours(12),
      eAvailWh: 10000,
      lastProbeC: 50,
      lastProbeTs: NOW - hours(12)
    })
  );
  // 12 h de trou mais Δt plafonné à 5 min → perte minime, pas un effondrement
  assert.ok(energy.eAvailWh > 9900, `eAvail=${energy.eAvailWh}`);
});

// ── Interpolation saisonnière ──
test('saison : hiver → eau froide plus froide (eFull ↑) + douche plus chère (moins de douches)', () => {
  const mk = (oc: number) =>
    updateEnergyModel(
      inp({ outdoorC: oc, tempC: 50, relayOn: false }),
      cfg(),
      st({
        lastUpdateTs: NOW - 60_000,
        eAvailWh: 8000,
        lastProbeC: 50,
        drawRefC: 50,
        drawRefTs: NOW - 60_000
      })
    );
  const summer = mk(25);
  const winter = mk(5);
  assert.ok(winter.result.eFullWh > summer.result.eFullWh); // tInlet hiver 9 < été 15
  assert.ok(winter.result.showers < summer.result.showers); // eDouche hiver 2800 > été 2000
});

// ── Init différée (sonde absente au redémarrage) ──
test('init différée : sonde null au 1er tick → demi-plein, puis RÉ-INIT au 1er relevé réel', () => {
  // 1er tick juste après restart : retained MQTT pas encore arrivé → provisoire
  const a = updateEnergyModel(inp({ tempC: null }), cfg(), st({ lastUpdateTs: null, eAvailWh: 0 }));
  assert.equal(a.energy.eAvailWh, Math.round(0.5 * E_FULL)); // 7656
  assert.equal(a.energy.lastProbeC, null);
  // 2e tick : la sonde arrive (51 °C) → ré-initialisation BASSE depuis la sonde
  const b = updateEnergyModel(inp({ tempC: 51 }), cfg(), st(a.energy));
  assert.equal(b.energy.eAvailWh, 348 * (51 - 15)); // 12528 — pas resté coincé à 7656
  assert.equal(b.energy.lastProbeC, 51);
});

// ── Moyenne multi-sources des températures de référence (patch 1b+) ──
test('averageTemp : moyenne de 2 sondes intérieures', () => {
  assert.equal(
    averageTemp([
      { name: 'SdB', tempC: 23.4 },
      { name: 'séjour', tempC: 22.4 }
    ]),
    22.9
  );
});

test('averageTemp : 3 sources extérieures (daikin + terrasse + météo)', () => {
  assert.equal(
    averageTemp([
      { name: 'daikin', tempC: 31 },
      { name: 'ext', tempC: 31.3 },
      { name: 'météo', tempC: 30.2 }
    ]),
    30.8
  );
});

test('averageTemp : une seule source dispo → sa valeur (cas dégradé)', () => {
  assert.equal(averageTemp([{ name: 'météo', tempC: 30.2 }]), 30.2);
});

test('averageTemp : aucune source → null (repli sur la constante saisonnière)', () => {
  assert.equal(averageTemp([]), null);
});
