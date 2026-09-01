/**
 * Étalonnage de la voie réseau EM-50 (em50-grid.ts).
 *   pnpm test:em50
 *
 * Ce que ces tests protègent : la voie 0 du Shelly sous-lit ~35 W. Sans
 * correction, Domo voit une injection permanente qui n'existe pas — et la
 * boucle SB3 baisse la consigne des Solarbank pour la « corriger », créant un
 * achat EDF bien réel. Confronté au compteur Enedis sur 3 421 demi-heures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.EM50_GRID_OFFSET_W = '35';
const { calibratedGridW, gridOffsetW } = await import('../src/lib/server/em50-grid.ts');

test('le talon nocturne cesse d’être vu comme une injection', () => {
  // Mesuré la nuit : le Shelly affiche −30 W pendant qu'Enedis voit +5 W.
  assert.equal(calibratedGridW(-30), 5);
});

test('une injection FRANCHE reste une injection', () => {
  // Parc plein, 1,2 kW au réseau : l'étalonnage ne doit pas la masquer.
  assert.equal(calibratedGridW(-1200), -1165);
});

test('un soutirage reste un soutirage, majoré du biais', () => {
  assert.equal(calibratedGridW(800), 835);
});

test('une mesure absente rend null — jamais 0, qui ferait croire à un compteur sain', () => {
  assert.equal(calibratedGridW(undefined), null);
  assert.equal(calibratedGridW(null), null);
  assert.equal(calibratedGridW(Number.NaN), null);
  assert.equal(calibratedGridW('12' as unknown), null);
});

test('l’offset est surchargeable sans toucher au code', () => {
  assert.equal(gridOffsetW(), 35);
  process.env.EM50_GRID_OFFSET_W = '0';
  assert.equal(gridOffsetW(), 0, 'un déploiement peut neutraliser la correction');
  process.env.EM50_GRID_OFFSET_W = 'nawak';
  assert.equal(gridOffsetW(), 0, 'une valeur illisible ne doit pas fabriquer un décalage');
  process.env.EM50_GRID_OFFSET_W = '35';
});
