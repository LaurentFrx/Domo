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
import {
  defaultProbeRelaxCalib,
  updateProbeRelaxCalib,
  type ProbeRelaxCalib
} from '../src/lib/server/cumulus/probe-relax-calib.ts';
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
    drawStratFactor: 2.8,
    probeFullRestC: 55,
    fastDropThresholdC: 1.0,
    fastDropWindowMin: 10,
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
    energyModel: energyModel(em),
    planner: {
      enabled: true,
      reserveShowers: 3,
      fullFraction: 0.95,
      horizonH: 18,
      peakFraction: 0.6,
      peakMinW: 1800,
      socFloorPct: 50
    }
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
    recentProbeC: null,
    recentProbeTs: null,
    cleanSinceRef: false,
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
  // amplitude corrigée du facteur de stratification (÷2,8) : ~724 Wh au lieu de ~2027
  assert.ok(
    result.drawEvent!.eDrawnWh > 690 && result.drawEvent!.eDrawnWh < 760,
    `eDrawn=${result.drawEvent?.eDrawnWh}`
  );
  assert.ok(energy.eAvailWh > 9250 && energy.eAvailWh < 9290, `eAvail=${energy.eAvailWh}`); // ~−724
});

test('drawStratFactor : l’amplitude du puisage est divisée par le facteur (stratification)', () => {
  const energy0 = {
    lastUpdateTs: NOW - 60_000,
    eAvailWh: 10000,
    lastProbeC: 48,
    lastProbeTs: NOW - 60_000,
    drawRefC: 48,
    drawRefTs: NOW - hours(1)
  };
  const f1 = updateEnergyModel(
    inp({ tempC: 42, relayOn: false }),
    cfg({ drawStratFactor: 1 }),
    st(energy0)
  );
  const f28 = updateEnergyModel(
    inp({ tempC: 42, relayOn: false }),
    cfg({ drawStratFactor: 2.8 }),
    st(energy0)
  );
  assert.ok(f1.result.drawEvent !== null && f28.result.drawEvent !== null);
  const ratio = f1.result.drawEvent!.eDrawnWh / f28.result.drawEvent!.eDrawnWh;
  assert.ok(ratio > 2.6 && ratio < 3.0, `ratio=${ratio}`); // ~2,8
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
  // Référence à 25 min (au-delà du seuil drawWindowMin) : assez proche du pic pour que
  // la relaxation post-plein (04/07) n'ait le temps d'expliquer qu'~1°C — la chute de
  // 4°C (jusqu'au plancher restHot=55°C) reste sans ambiguïté un vrai tirage.
  const { energy, result } = updateEnergyModel(
    inp({ tempC: 55, relayOn: false }), // ≥55 → restHot
    cfg(),
    st({
      lastUpdateTs: NOW - 60_000,
      eAvailWh: 12000,
      lastProbeC: 59,
      drawRefC: 59,
      drawRefTs: NOW - 25 * 60_000
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

// ═══════════════════════════════════════════════════════════════════════════
// FIX RELAXATION POST-PLEIN (04/07/2026) — faux puisage éliminé, vrai puisage gardé
// ═══════════════════════════════════════════════════════════════════════════

const NO_FIX: ProbeRelaxCalib = { amplitudeC: 0, tauMin: 120, samples: 0, updatedAt: 0 };
const min = (m: number) => m * 60_000;

/**
 * Déroule une courbe de sonde [offsetMin, °C] à travers le modèle, état chaîné.
 * Le premier point est le PIC (t=0) juste après un plein ; le ballon reste ancré
 * tant que la sonde est chaude (reproduit le vrai flux : relayOn=false, ballonCharged).
 */
function replay(
  points: [number, number][],
  calib: ProbeRelaxCalib,
  opts: { anchorBeforePeakMin?: number; roomC?: number } = {}
): { drawEvents: number; eAvailWh: number; firstDrawAtMin: number | null } {
  const anchorBefore = opts.anchorBeforePeakMin ?? 26;
  const roomC = opts.roomC ?? 24.9;
  const peakC = points[0][1];
  const t0 = NOW;
  let energy: EnergyState = energyState({
    eAvailWh: E_FULL,
    lastUpdateTs: t0 - min(1),
    lastProbeC: peakC,
    lastProbeTs: t0 - min(1),
    lastAnchorTs: t0 - min(anchorBefore),
    wasFull: true,
    drawRefC: peakC,
    drawRefTs: t0,
    recentProbeC: peakC,
    recentProbeTs: t0,
    cleanSinceRef: true,
    dayDate: '2023-11-14'
  });
  let drawEvents = 0;
  let firstDrawAtMin: number | null = null;
  const workCalib = { ...calib };
  for (const [offsetMin, probe] of points) {
    const now = t0 + min(offsetMin);
    const { energy: next, result } = updateEnergyModel(
      inp({ now, tempC: probe, relayOn: false, indoorC: roomC, outdoorC: 25 }),
      cfg({ lossCoeffWhPerCh: 2.1 }), // conditions RÉELLES de prod (le helper est à 2,8)
      st(energy, { ballonCharged: true, chargedAtTempC: 59, lastTickTs: energy.lastUpdateTs }),
      workCalib
    );
    energy = next;
    if (result.drawEvent) {
      drawEvents += 1;
      if (firstDrawAtMin === null) firstDrawAtMin = offsetMin;
    }
  }
  return { drawEvents, eAvailWh: energy.eAvailWh, firstDrawAtMin };
}

// Courbe RÉELLE du 04/07 depuis le pic sonde (15:16, 59,8°C) — maison vide, aucun
// tirage possible. Le détecteur V1 a journalisé un FAUX « Eau chaude utilisée » à
// 16:47 (t+91 min). Échantillonnée ~10 min depuis history.db (energy_samples).
const RELAX_0704: [number, number][] = [
  [0, 59.8],
  [4, 59.7],
  [14, 59.6],
  [24, 59.4],
  [34, 59.1],
  [44, 58.9],
  [54, 58.6],
  [64, 58.3],
  [74, 57.9],
  [84, 57.7],
  [91, 57.4],
  [104, 57.2],
  [114, 56.9],
  [124, 56.8],
  [134, 56.4],
  [144, 56.3],
  [154, 56.1],
  [164, 55.9],
  [174, 55.7],
  [184, 55.5],
  [189, 55.4]
];

test('REJEU 04/07 SANS fix (calib A=0) → le faux puisage de 16:47 se reproduit (bug confirmé)', () => {
  const r = replay(RELAX_0704, NO_FIX);
  assert.ok(r.drawEvents >= 1, 'le détecteur V1 déclenche un faux puisage');
  assert.ok(
    r.firstDrawAtMin !== null && r.firstDrawAtMin >= 85 && r.firstDrawAtMin <= 95,
    `déclenchement attendu vers t+91 min (16:47), obtenu t+${r.firstDrawAtMin}`
  );
});

test('REJEU 04/07 AVEC fix → AUCUN puisage détecté, jauge reste à plein', () => {
  const r = replay(RELAX_0704, defaultProbeRelaxCalib()); // A=6, tau=120
  assert.equal(r.drawEvents, 0, 'plus aucun faux puisage sur toute la journée');
  assert.equal(r.eAvailWh, E_FULL, 'la jauge reste au plein');
});

test('vraie douche 30 min après un plein → toujours DÉTECTÉE (discriminant de pente)', () => {
  // Pic à t0, plein récent (dans la fenêtre relax) ; une chute franche de 6°C en 8 min.
  const { result, energy } = updateEnergyModel(
    inp({ now: NOW + min(30), tempC: 52, relayOn: false, indoorC: 24.9, outdoorC: 25 }),
    cfg(),
    st(
      energyState({
        eAvailWh: E_FULL,
        lastUpdateTs: NOW + min(22),
        lastProbeC: 58,
        lastProbeTs: NOW + min(22),
        lastAnchorTs: NOW - min(5), // plein il y a 35 min → relaxation ACTIVE
        wasFull: true,
        drawRefC: 59,
        drawRefTs: NOW,
        recentProbeC: 58, // il y a 8 min
        recentProbeTs: NOW + min(22),
        cleanSinceRef: true
      }),
      { ballonCharged: false }
    ),
    defaultProbeRelaxCalib()
  );
  assert.ok(result.drawEvent !== null, 'la douche est détectée malgré la relaxation en cours');
  assert.ok(result.drawEvent!.eDrawnWh > 0);
  assert.ok(energy.eAvailWh < E_FULL, 'la jauge baisse (vrai puisage)');
});

test('puisage LENT loin de tout plein → détecté (la relaxation NE s’applique pas)', () => {
  // Chute de 3°C en 40 min, dernier plein il y a 6 h → relaxPostFull=false → détection normale.
  const { result } = updateEnergyModel(
    inp({ now: NOW, tempC: 47, relayOn: false, indoorC: 24.9, outdoorC: 25 }),
    cfg(),
    st(
      energyState({
        eAvailWh: 8000,
        lastUpdateTs: NOW - min(1),
        lastProbeC: 50,
        lastProbeTs: NOW - min(1),
        lastAnchorTs: NOW - hours(6), // plein trop ancien
        drawRefC: 50,
        drawRefTs: NOW - min(40),
        recentProbeC: 50, // pente douce : pas de fastDraw, doit passer par la fenêtre lente
        recentProbeTs: NOW - min(9),
        cleanSinceRef: true
      })
    ),
    defaultProbeRelaxCalib()
  );
  assert.ok(result.drawEvent !== null, 'un puisage lent hors fenêtre post-plein reste détecté');
});

test('deux pleins rapprochés → le terme de relaxation se réarme au dernier pic', () => {
  // 1er plein (pic à t0), relaxation, puis un 2e plein remonte la sonde à t+40 (nouveau pic).
  const seq: [number, number][] = [
    [0, 59.6],
    [15, 59.3],
    [30, 58.9], // relaxation du 1er plein
    [40, 60.0], // 2e plein : la sonde REMONTE → nouveau pic, drawRef réarmé
    [55, 59.7],
    [70, 59.3],
    [85, 58.9] // relaxation du 2e plein (courte depuis SON pic)
  ];
  // Le 2e « pic » n'est PAS suivi d'un nouvel anchor dans replay() (lastAnchorTs figé),
  // donc on vérifie surtout qu'aucun faux puisage ne surgit sur la séquence complète.
  const r = replay(seq, defaultProbeRelaxCalib(), { anchorBeforePeakMin: 20 });
  assert.equal(r.drawEvents, 0, 'aucun faux puisage à travers deux relaxations enchaînées');
});

// ── EWMA bornée (calibration apprise robuste aux aberrations) ──
test('calibration : valeur aberrante rejetée (amplitude reste ≤ 8°C, tau borné)', () => {
  const c = defaultProbeRelaxCalib(); // A=6, tau=120
  // Fenêtre absurde : 50°C de « relaxation » en 60 min (impossible physiquement).
  for (let i = 0; i < 20; i++) updateProbeRelaxCalib(60, 50, c, NOW);
  assert.ok(c.amplitudeC <= 8 && c.amplitudeC >= 0, `amplitude bornée, obtenu ${c.amplitudeC}`);
  assert.ok(c.tauMin >= 20 && c.tauMin <= 240, `tau borné, obtenu ${c.tauMin}`);
});

test('calibration : fenêtre trop courte (<30 min) ignorée', () => {
  const c = defaultProbeRelaxCalib();
  const before = { ...c };
  const updated = updateProbeRelaxCalib(15, 3, c, NOW);
  assert.equal(updated, false);
  assert.deepEqual(c, before);
});

test('calibration : une relaxation propre plausible fait converger doucement (EWMA)', () => {
  const c = { amplitudeC: 6, tauMin: 120, samples: 0, updatedAt: 0 };
  // Fenêtre de 200 min avec 4°C observés → l'amplitude implicite (~4,9) tire A vers le bas, lentement.
  const a0 = c.amplitudeC;
  updateProbeRelaxCalib(200, 4, c, NOW);
  assert.ok(c.amplitudeC < a0, 'A évolue vers la valeur observée');
  assert.ok(Math.abs(c.amplitudeC - a0) < 1.5, 'mais lentement (EWMA), pas de saut brutal');
  assert.equal(c.samples, 1);
});
