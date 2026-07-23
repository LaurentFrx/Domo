/**
 * Tests du modèle continu de désirabilité (desirability.ts, fonction pure).
 * VERSION SÛRE : ne chauffe QUE sur surplus confirmé, batterie haute, jamais en
 * important. Lancer : pnpm test:desir
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

/** État neutre : midi, cuve mi-pleine, batterie 60 %, aucun surplus franc. */
function di(o: Partial<DesInputs> = {}): DesInputs {
  return {
    sunElevDeg: 50,
    pvApsW: 600,
    eAvailWh: 8000,
    eFullWh: 15312,
    gridPowerW: 0,
    maxAcChargeW: 0,
    socFrac: 0.6,
    heaterW: 2900,
    applianceActive: false,
    ...o
  };
}
const D = (o: Partial<DesInputs> = {}) => computeDesirability(di(o), cfg).D;

// ─── smootherstep ───────────────────────────────────────────────────────────

test('smootherstep : bornes, milieu, monotonie', () => {
  assert.equal(smootherstep(0, 10, -5), 0);
  assert.equal(smootherstep(0, 10, 15), 1);
  assert.equal(smootherstep(0, 10, 5), 0.5);
  assert.ok(smootherstep(0, 10, 3) < smootherstep(0, 10, 7));
});

test('smootherstep : PAS DE FALAISE — pas de 2 % dans une bande réelle reste doux', () => {
  const a = smootherstep(0.75, 0.9, 0.83);
  const b = smootherstep(0.75, 0.9, 0.85);
  assert.ok(Math.abs(a - b) < 0.25); // vs 1,0 pour un seuil booléen
});

// ─── Portails / vetos durs ──────────────────────────────────────────────────

test('nuit (soleil sous l’horizon) → D = 0', () => {
  assert.equal(D({ sunElevDeg: -10, gridPowerW: -2500 }), 0);
});

test('cuve pleine → D = 0 même avec surplus franc', () => {
  assert.equal(D({ eAvailWh: 15200, gridPowerW: -2500 }), 0);
});

test('VETO cuisine → D = 0 même avec tout au vert', () => {
  assert.equal(D({ applianceActive: true, socFrac: 0.95, pvApsW: 800 }), 0);
});

test('VETO import → D = 0 dès qu’on soutire (jamais de chauffe HP)', () => {
  // Batterie pleine + soleil franc (écrêtage) MAIS soutirage 300 W → veto dur.
  assert.equal(D({ socFrac: 0.95, pvApsW: 800, gridPowerW: 300 }), 0);
});

// ─── Surplus CONFIRMÉ → chauffe ─────────────────────────────────────────────

test('export franc au compteur → chauffe', () => {
  assert.ok(D({ gridPowerW: -2000 }) > cfg.dOn);
});

test('ÉCRÊTAGE : batterie quasi pleine (93 %) + soleil franc (APS 800 W) → chauffe', () => {
  // Le cas dominant l’été sous zéro-export ; corrige le faux négatif de la v1
  // (freeCurtail ne dépend plus de la dérivée de charge).
  assert.ok(D({ socFrac: 0.93, pvApsW: 800, maxAcChargeW: 0, gridPowerW: -20 }) > cfg.dOn);
});

test('charge batterie FORTE au-dessus de la réserve (SoC 85 %, 2,3 kW) → chauffe', () => {
  assert.ok(D({ socFrac: 0.85, maxAcChargeW: 2300 }) > cfg.dOn);
});

// ─── Sûreté : ce qui ne DOIT PAS chauffer ───────────────────────────────────

test('LEÇON 23/07 : charge à BAS SoC (51 %, 4,7 kW) → PAS de chauffe (elle se refait)', () => {
  assert.ok(D({ socFrac: 0.51, maxAcChargeW: 4700, gridPowerW: -20 }) < cfg.dOff);
});

test('SÛRETÉ : batterie moyenne (60 %) sans surplus franc → PAS de chauffe (pas de prêt spéculatif)', () => {
  assert.ok(D({ socFrac: 0.6, maxAcChargeW: 600, pvApsW: 500, gridPowerW: 0 }) < cfg.dOff);
});

test('SÛRETÉ CARDINALE : cuve BASSE sans surplus → PAS de chauffe (jamais de chauffe HP de panique)', () => {
  // Le défaut bloquant de la v1 : cuve à 2 douches, batterie basse, midi couvert
  // → l’ancien modèle forçait D=1 (import EDF). Interdit désormais : c’est le plan
  // HC nocturne qui garantit le confort, pas une chauffe de panique en journée.
  assert.equal(D({ eAvailWh: 2500, socFrac: 0.2, pvApsW: 400, maxAcChargeW: 0, gridPowerW: 0 }), 0);
});

test('charge à bas SoC même APS fort (batterie pas pleine) → PAS de chauffe', () => {
  assert.ok(D({ socFrac: 0.5, pvApsW: 900, maxAcChargeW: 1500, gridPowerW: -10 }) < cfg.dOff);
});

// ─── Hystérésis ─────────────────────────────────────────────────────────────

test('hystérésis : allume au-dessus de dOn, reste jusqu’à dOff', () => {
  assert.equal(hysteresisOn(0.6, false, cfg), true);
  assert.equal(hysteresisOn(0.45, true, cfg), true);
  assert.equal(hysteresisOn(0.3, true, cfg), false);
  assert.equal(hysteresisOn(0.45, false, cfg), false);
});
