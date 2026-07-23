/**
 * Tests du modèle continu de désirabilité (desirability.ts, fonction pure).
 * Lancer : pnpm test:desir
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDesirability,
  defaultDesConfig,
  hysteresisOn,
  smootherstep,
  type DesInputs
} from '../src/lib/server/cumulus/desirability.ts';

const cfg = defaultDesConfig();

/** État de journée neutre (midi, cuve mi-pleine, batterie 50 %, pas de surplus franc). */
function di(o: Partial<DesInputs> = {}): DesInputs {
  return {
    sunElevDeg: 50,
    eAvailWh: 8000,
    eFullWh: 15312,
    comfortReserveWh: 4000,
    hardComfortWh: 2000,
    lossPerHWh: 60,
    minutesToDeadline: 600,
    gridPowerW: 0,
    maxAcChargeW: 0,
    socFrac: 0.5,
    dSocFracPerH: 0,
    forecastRemainingKwh: 5,
    eveningReserveKwh: 7,
    batteryCapacityKwh: 12.6,
    heaterW: 2900,
    applianceActive: false,
    ...o
  };
}
const D = (o: Partial<DesInputs> = {}) => computeDesirability(di(o), cfg).D;

// ─── smootherstep : continuité et bornes ────────────────────────────────────

test('smootherstep : 0 au bord bas, 1 au bord haut, 0.5 au milieu, monotone', () => {
  assert.equal(smootherstep(0, 10, -5), 0);
  assert.equal(smootherstep(0, 10, 15), 1);
  assert.equal(smootherstep(0, 10, 5), 0.5);
  assert.ok(smootherstep(0, 10, 3) < smootherstep(0, 10, 7));
});

test('smootherstep : PAS DE FALAISE — un pas de 2 % dans une bande réelle reste doux', () => {
  // Bande de gating SoC du modèle (0.75-0.90). Un seuil BOOLÉEN sauterait de 0 à 1
  // (écart 1,0). Le smootherstep, lui, varie graduellement : bien moins qu'une bascule.
  const a = smootherstep(0.75, 0.9, 0.83);
  const b = smootherstep(0.75, 0.9, 0.85);
  assert.ok(Math.abs(a - b) < 0.25);
});

// ─── Portails durs : nuit, hiver, cuve pleine, cuisine ──────────────────────

test('nuit (soleil sous l’horizon) → D = 0', () => {
  assert.equal(D({ sunElevDeg: -10 }), 0);
});

test('hiver SANS surplus (soleil bas, pas d’export, forecast pauvre) → D ≈ 0 (repli HC)', () => {
  // En hiver le solaire est structurellement mort NON par un seuil dur d’élévation
  // (le modèle capterait un rare gratuit à 22° — c’est correct) mais parce qu’il
  // n’y a PAS de surplus : ni export, ni charge batterie, forecast au plancher.
  assert.ok(D({ sunElevDeg: 22, gridPowerW: 0, socFrac: 0.4, forecastRemainingKwh: 1.5 }) < 0.05);
});

test('cuve pleine → D = 0 même avec surplus franc', () => {
  assert.equal(D({ eAvailWh: 15200, gridPowerW: -2500 }), 0);
});

test('veto cuisine (gros appareil) → D = 0 même avec tout le reste au vert', () => {
  assert.equal(D({ applianceActive: true, gridPowerW: -2500, eAvailWh: 5000 }), 0);
});

// ─── Voie surplus franc : ne jamais gaspiller du 0 € ────────────────────────

test('export franc au compteur → chauffe (D élevé)', () => {
  assert.ok(D({ gridPowerW: -2000 }) > cfg.dOn);
});

test('charge batterie AU-DESSUS de la réserve (SoC 88 %) → chauffe (vrai surplus)', () => {
  assert.ok(D({ socFrac: 0.88, maxAcChargeW: 1600 }) > cfg.dOn);
});

test('LEÇON 23/07 : charge batterie à BAS SoC (51 %, 4,7 kW) → PAS de chauffe (elle se refait)', () => {
  // Pas de surplus franc, pas de prêt (forecast neutre) : la batterie remplit sa
  // propre réserve, le ballon ne doit pas concourir.
  assert.ok(D({ socFrac: 0.51, maxAcChargeW: 4700, forecastRemainingKwh: 4 }) < cfg.dOff);
});

// ─── Voie de prêt (plan journalier) : trois pierres alignées ────────────────

test('prêt : batterie confortable (80 %) + journée solaire (forecast 8 kWh) + soleil → chauffe', () => {
  assert.ok(D({ socFrac: 0.8, forecastRemainingKwh: 8, gridPowerW: 0 }) > cfg.dOn);
});

test('prêt BLOQUÉ : batterie confortable mais journée PAUVRE (forecast 1 kWh) → pas de prêt', () => {
  assert.ok(D({ socFrac: 0.8, forecastRemainingKwh: 1, gridPowerW: 0 }) < cfg.dOff);
});

test('prêt BLOQUÉ : journée solaire mais batterie SOUS sa réserve (SoC 25 %) → pas de prêt', () => {
  assert.ok(D({ socFrac: 0.25, forecastRemainingKwh: 8, gridPowerW: 0 }) < cfg.dOff);
});

// ─── Urgence confort ────────────────────────────────────────────────────────

test('cuve proche du confort dur (sous réserve) le jour → urgence chauffe', () => {
  assert.ok(D({ eAvailWh: 2500, forecastRemainingKwh: 1, socFrac: 0.2 }) > cfg.dOn);
});

test('urgence confort la NUIT → D = 0 (c’est le plan HC qui gère, pas le solaire)', () => {
  assert.equal(D({ eAvailWh: 2500, sunElevDeg: -10 }), 0);
});

// ─── Hystérésis ─────────────────────────────────────────────────────────────

test('hystérésis : allume au-dessus de dOn, reste allumé jusqu’à dOff', () => {
  assert.equal(hysteresisOn(0.6, false, cfg), true); // franchit dOn 0.55
  assert.equal(hysteresisOn(0.45, true, cfg), true); // reste ON (> dOff 0.35)
  assert.equal(hysteresisOn(0.3, true, cfg), false); // coupe sous dOff
  assert.equal(hysteresisOn(0.45, false, cfg), false); // n’allume pas sous dOn
});
