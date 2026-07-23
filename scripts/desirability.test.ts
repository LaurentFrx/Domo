/**
 * Tests du modèle continu de désirabilité (desirability.ts, fonction pure).
 * VERSION SÛRE (2e refonte) : ne chauffe QUE sur du surplus RÉELLEMENT gratuit —
 * export franc, charge > heater, ou ÉCRÊTAGE PROUVÉ (batterie pleine QUI N'ABSORBE
 * PLUS + soleil franc). Jamais en important, jamais compteur muet, jamais en
 * puisant une batterie qui chargeait encore. Lancer : pnpm test:desir
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

/** État neutre : midi, cuve mi-pleine, batterie 60 %, aucun surplus franc.
 *  Par défaut socFloorFrac SUIT socFrac (hypothèse mono-pack) ; les tests de décalage
 *  de périmètre le fixent explicitement plus bas que la moyenne. */
function di(o: Partial<DesInputs> = {}): DesInputs {
  const base: DesInputs = {
    sunElevDeg: 50,
    pvApsW: 600,
    eAvailWh: 8000,
    eFullWh: 15312,
    gridPowerW: 0,
    em50Available: true,
    maxAcChargeW: 0,
    socFrac: 0.6,
    socFloorFrac: 0.6,
    heaterW: 2900,
    applianceActive: false,
    ...o
  };
  if (o.socFrac !== undefined && o.socFloorFrac === undefined) base.socFloorFrac = o.socFrac;
  return base;
}
const D = (o: Partial<DesInputs> = {}) => computeDesirability(di(o), cfg).D;

// ─── smootherstep ───────────────────────────────────────────────────────────

test('smootherstep : bornes, milieu, monotonie', () => {
  assert.equal(smootherstep(0, 10, -5), 0);
  assert.equal(smootherstep(0, 10, 15), 1);
  assert.equal(smootherstep(0, 10, 5), 0.5);
  assert.ok(smootherstep(0, 10, 3) < smootherstep(0, 10, 7));
});

test('smootherstep : PAS DE FALAISE — un pas de 2 % dans une bande réelle reste doux', () => {
  // Bande battIsSurplus (0,75→0,9, large de 15 %) : franchir 0,83↔0,85 (le vieux
  // seuil dur « 64 % bloque tout ») ne fait plus qu'un petit pas, pas une falaise.
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
  assert.equal(D({ applianceActive: true, socFrac: 0.98, pvApsW: 800, maxAcChargeW: 0 }), 0);
});

test('VETO import → D = 0 dès qu’on soutire (jamais de chauffe HP)', () => {
  // Batterie pleine + soleil franc (écrêtage) MAIS soutirage 300 W → veto dur.
  assert.equal(D({ socFrac: 0.98, pvApsW: 800, maxAcChargeW: 0, gridPowerW: 300 }), 0);
});

test('VETO compteur muet → D = 0 (import non vérifiable, comme le pilote booléen)', () => {
  // EM-50 injoignable → gridPowerW=0 RESSEMBLE à un réseau sain : on refuse quand même.
  assert.equal(
    D({ em50Available: false, socFrac: 0.98, pvApsW: 800, maxAcChargeW: 0, gridPowerW: 0 }),
    0
  );
});

// ─── Surplus CONFIRMÉ → chauffe ─────────────────────────────────────────────

test('export franc au compteur → chauffe', () => {
  assert.ok(D({ gridPowerW: -2000 }) > cfg.dOn);
});

test('ÉCRÊTAGE PROUVÉ : batterie pleine (98 %) QUI N’ABSORBE PLUS (0 W) + soleil franc → chauffe', () => {
  // Le cas dominant l’été sous zéro-export : batterie saturée, PV bridé récupérable.
  assert.ok(D({ socFrac: 0.98, maxAcChargeW: 0, pvApsW: 800, gridPowerW: -20 }) > cfg.dOn);
});

test('charge batterie qui DÉPASSE le heater (SoC 90 %, 3,5 kW) → chauffe (reste net-charge)', () => {
  assert.ok(D({ socFrac: 0.9, maxAcChargeW: 3500, gridPowerW: -20 }) > cfg.dOn);
});

// ─── Sûreté : ce qui ne DOIT PAS chauffer ───────────────────────────────────

test('BUG revue 24/07 : batterie 91 % QUI ABSORBE ENCORE 1,2 kW → PAS de chauffe (pas d’écrêtage)', () => {
  // Une batterie qui charge encore n’écrête pas : chauffer volerait sa charge
  // (puisage réserve invisible au veto sous zéro-export). Doit rester éteint.
  assert.ok(D({ socFrac: 0.91, maxAcChargeW: 1200, pvApsW: 700, gridPowerW: -30 }) < cfg.dOff);
});

test('charge SOUS le heater (SoC 90 %, 2,3 kW) → PAS de chauffe (chauffer puiserait 600 W)', () => {
  assert.ok(D({ socFrac: 0.9, maxAcChargeW: 2300, pvApsW: 650, gridPowerW: -20 }) < cfg.dOff);
});

test('DÉCALAGE PÉRIMÈTRE (revue 24/07-2) : Max AC pleine (moy 97 %) mais un SB3 à 96 % → PAS de chauffe', () => {
  // socFrac moyen élevé (Max AC 100 % tire la moyenne) MAIS socFloorFrac = pack le
  // moins plein (SB3 à 96 %, absorbe encore) → le parc n'écrête pas vraiment. Le gate
  // sur le plancher, pas la moyenne, doit garder freeCurtail bas (corrige le faux
  // écrêtage où la Max AC pleine masquait un SB3 en charge).
  assert.ok(
    D({ socFrac: 0.973, socFloorFrac: 0.96, maxAcChargeW: 0, pvApsW: 800, gridPowerW: -20 }) <
      cfg.dOff
  );
});

test('LEÇON 23/07 : charge à BAS SoC (51 %, 4,7 kW) → PAS de chauffe (elle se refait)', () => {
  assert.ok(D({ socFrac: 0.51, maxAcChargeW: 4700, gridPowerW: -20 }) < cfg.dOff);
});

test('SÛRETÉ : batterie moyenne (60 %) sans surplus franc → PAS de chauffe (pas de prêt spéculatif)', () => {
  assert.ok(D({ socFrac: 0.6, maxAcChargeW: 600, pvApsW: 500, gridPowerW: 0 }) < cfg.dOff);
});

test('SÛRETÉ CARDINALE : cuve BASSE sans surplus → PAS de chauffe (jamais de chauffe HP de panique)', () => {
  // Le défaut bloquant de la v1 : cuve à 2 douches, batterie basse, midi couvert
  // → l’ancien modèle forçait D=1 (import EDF). Interdit : c’est le plan HC nocturne
  // qui garantit le confort, pas une chauffe de panique en journée.
  assert.equal(D({ eAvailWh: 2500, socFrac: 0.2, pvApsW: 400, maxAcChargeW: 0, gridPowerW: 0 }), 0);
});

test('Max AC muette (charge inconnue) à SoC haut + soleil → PAS d’écrêtage prouvé → PAS de chauffe', () => {
  // On ne peut pas prouver que la batterie a cessé d’absorber → refus (repli HC).
  assert.ok(D({ socFrac: 0.98, maxAcChargeW: null, pvApsW: 800, gridPowerW: -20 }) < cfg.dOff);
});

// ─── Hystérésis ─────────────────────────────────────────────────────────────

test('hystérésis : allume au-dessus de dOn, reste jusqu’à dOff', () => {
  assert.equal(hysteresisOn(0.6, false, cfg), true);
  assert.equal(hysteresisOn(0.45, true, cfg), true);
  assert.equal(hysteresisOn(0.3, true, cfg), false);
  assert.equal(hysteresisOn(0.45, false, cfg), false);
});
