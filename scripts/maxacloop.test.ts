/**
 * Tests de la loi de commande de la boucle de charge Max AC.
 *
 * Ce qui est verrouillé ici n'est pas « le code fait ce qu'il fait » mais les
 * règles qui rendent la boucle sûre : on ne pilote jamais sans mesure, on rend
 * la main au moindre doute, on n'achète pas, et on ne prend jamais aux SB3 ce
 * dont elles ont besoin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMaxAc } from '../src/lib/server/maxacloop/decide.ts';
import {
  MAXAC_LOOP_DEFAULTS,
  emptyMaxAcState,
  type MaxAcLoopInputs,
  type MaxAcLoopState
} from '../src/lib/server/maxacloop/types.ts';

const cfg = MAXAC_LOOP_DEFAULTS;
const T0 = 1_700_000_000_000;

/** Situation nominale : SB3 pleines et bridées, Max AC avec de la place, soleil. */
function inputs(over: Partial<MaxAcLoopInputs> = {}): MaxAcLoopInputs {
  return {
    now: T0,
    gridW: 0,
    gridAvailable: true,
    maxAcBattW: -600, // charge 600 W spontanément
    maxAcSocPct: 35,
    maxAcAvailable: true,
    maxAcMode: 0,
    sb3SocPct: 100,
    sb3Available: true,
    sb3PvW: 0, // bridé
    sb3OutW: 0,
    apsW: 800,
    cumulusW: 0,
    ...over
  };
}

/** État « on pilote déjà », consigne de charge en cours. */
function piloting(setpointW: number, over: Partial<MaxAcLoopState> = {}): MaxAcLoopState {
  return { ...emptyMaxAcState(), setpointW, ...over };
}

/** En pilotage, l'appareil est en mode 3 : la loi le vérifie désormais. */
function enMode3(over: Partial<MaxAcLoopInputs> = {}): MaxAcLoopInputs {
  return inputs({ maxAcMode: 3, ...over });
}

// ─── 1. On ne pilote jamais à l'aveugle ────────────────────────────────────

test('compteur muet → on rend la main, jamais de pilotage à l’aveugle', () => {
  const d = decideMaxAc(enMode3({ gridAvailable: false }), cfg, piloting(-1200));
  assert.equal(d.mode, 'leave');
  assert.equal(d.writeW, 0);
  assert.equal(d.nextState.setpointW, null);
});

test('Max AC injoignable en Modbus → on rend la main', () => {
  const d = decideMaxAc(enMode3({ maxAcAvailable: false }), cfg, piloting(-1200));
  assert.equal(d.mode, 'leave');
});

test('état des SB3 inconnu → on rend la main (on ne sait pas si leur PV est bridé)', () => {
  const d = decideMaxAc(enMode3({ sb3Available: false, sb3SocPct: null }), cfg, piloting(-1200));
  assert.equal(d.mode, 'leave');
});

test('aucune mesure ET on ne pilotait pas → idle, aucune écriture', () => {
  const d = decideMaxAc(inputs({ gridAvailable: false }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
  assert.equal(d.writeW, null);
});

// ─── 2. Conditions d'exploitation ──────────────────────────────────────────

test('SB3 pas pleines → on ne leur prend pas leur PV', () => {
  const d = decideMaxAc(inputs({ sb3SocPct: 80 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
  assert.match(d.reason, /80 %/);
});

test('Max AC déjà pleine → rien à remplir', () => {
  const d = decideMaxAc(inputs({ maxAcSocPct: 95 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
});

test('nuit (APS muet) → on ne prend pas la barre', () => {
  const d = decideMaxAc(inputs({ apsW: 0 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
});

test('chauffe du ballon en cours → on lui laisse la place', () => {
  const d = decideMaxAc(inputs({ cumulusW: 2900 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
  assert.match(d.reason, /chauffe-eau/);
});

test('PV des SB3 NON bridé → rien à débloquer, on n’entre pas', () => {
  const d = decideMaxAc(inputs({ sb3PvW: 1500 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
});

test('PV redevenu franc PENDANT le pilotage → on continue (c’est notre propre effet)', () => {
  const d = decideMaxAc(enMode3({ sb3PvW: 1500 }), cfg, piloting(-1200));
  assert.notEqual(d.mode, 'leave');
});

// ─── 3. Entrée sans échelon ────────────────────────────────────────────────

test('entrée : la consigne de départ vaut la charge SPONTANÉE (pas de saut à 0)', () => {
  const d = decideMaxAc(inputs({ maxAcBattW: -600 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'enter');
  assert.equal(d.writeW, -600);
});

test('entrée refusée si la place restante est dérisoire', () => {
  // fillHorizonH = 0,05 h : place = capacité × (1 − SoC) / 0,05.
  // 89,9 % de 140 Wh ⇒ 14 Wh ⇒ 283 W, sous minChargeW (300).
  const d = decideMaxAc(
    inputs({ maxAcSocPct: 89.9 }),
    { ...cfg, maxAcCapacityWh: 140 },
    emptyMaxAcState()
  );
  assert.equal(d.mode, 'idle');
  assert.match(d.reason, /place trop faible/);
});

// ─── 4. Asservissement ─────────────────────────────────────────────────────

test('surplus au compteur → on CHARGE davantage', () => {
  const d = decideMaxAc(enMode3({ gridW: -400 }), cfg, piloting(-600));
  assert.equal(d.mode, 'adjust');
  assert.ok(d.writeW !== null && d.writeW < -600, `attendu < -600, reçu ${d.writeW}`);
});

test('import au compteur → on RÉDUIT la charge', () => {
  const d = decideMaxAc(enMode3({ gridW: 200 }), cfg, piloting(-1200));
  assert.equal(d.mode, 'adjust');
  assert.ok(d.writeW !== null && d.writeW > -1200, `attendu > -1200, reçu ${d.writeW}`);
});

test('réseau à l’équilibre, palier récent → tolérance, aucune écriture', () => {
  // Sans `lastProbeTs` récent la boucle sonderait : c'est justement son rôle.
  const d = decideMaxAc(enMode3({ gridW: 10 }), cfg, piloting(-1000, { lastProbeTs: T0 - 5_000 }));
  assert.equal(d.mode, 'hold');
  assert.equal(d.writeW, null);
});

test('un ACHAT de 40 W est corrigé : la tolérance côté import est quasi nulle', () => {
  // Régression du 13/09 : avec une bande morte symétrique sur la consigne, la
  // boucle se garait sur +30 à +130 W d'achat et n'en bougeait plus.
  const d = decideMaxAc(enMode3({ gridW: 40 }), cfg, piloting(-1000, { lastProbeTs: T0 - 5_000 }));
  assert.equal(d.mode, 'adjust');
  assert.ok(d.writeW !== null && d.writeW > -1000, `attendu une baisse, reçu ${d.writeW}`);
});

test('un SURPLUS de 40 W est toléré : ce n’est pas une faute', () => {
  const d = decideMaxAc(enMode3({ gridW: -40 }), cfg, piloting(-1000, { lastProbeTs: T0 - 5_000 }));
  assert.equal(d.mode, 'hold');
});

test('le pas est limité À LA MONTÉE : pas d’échelon même sur une grosse erreur', () => {
  const d = decideMaxAc(enMode3({ gridW: -3000 }), cfg, piloting(-400));
  assert.ok(d.writeW !== null && Math.abs(d.writeW + 400) <= cfg.slewW + 1);
});

test('à la DESCENTE, aucune limite de pas : l’achat est corrigé d’un coup', () => {
  // gain 0,6 sur 2 000 W d'import = 1 200 W retirés en un tick, au-delà du slew.
  const d = decideMaxAc(enMode3({ gridW: 2000 }), cfg, piloting(-2000));
  assert.ok(d.writeW !== null && d.writeW > -2000 + cfg.slewW, `reçu ${d.writeW}`);
});

test('la consigne ne dépasse JAMAIS le plafond de charge', () => {
  let st = piloting(-cfg.maxChargeW);
  for (let i = 0; i < 10; i++) {
    const d = decideMaxAc(enMode3({ gridW: -2000, now: T0 + i * 20_000 }), cfg, st);
    st = d.nextState;
    assert.ok((st.setpointW ?? 0) >= -cfg.maxChargeW);
  }
});

test('la consigne ne devient jamais positive (on ne commande pas une décharge)', () => {
  let st = piloting(-200);
  for (let i = 0; i < 10; i++) {
    const d = decideMaxAc(enMode3({ gridW: 500, now: T0 + i * 20_000 }), cfg, st);
    st = d.nextState;
    if (st.setpointW !== null) assert.ok(st.setpointW <= 0, `consigne positive : ${st.setpointW}`);
  }
});

test('la place restante borne la consigne mieux que le plafond', () => {
  // 88 % de 7 200 Wh ⇒ 864 Wh ⇒ 3 456 W sur 0,25 h : c'est le plafond qui borne.
  // À 97 % la condition maxAcRoomPct sort avant. On teste donc la borne par capacité.
  const d = decideMaxAc(
    inputs({ gridW: -3000, maxAcSocPct: 80 }),
    { ...cfg, maxAcCapacityWh: 2000, slewW: 5000 },
    piloting(-100)
  );
  const plafondPlace = (2000 * 0.2) / 0.25; // 1 600 W
  assert.ok(d.writeW !== null && d.writeW >= -plafondPlace - 1);
});

// ─── 5. Abandon sur import ─────────────────────────────────────────────────

test('un import franc mais isolé ne suffit pas à abandonner', () => {
  const d = decideMaxAc(enMode3({ gridW: 300 }), cfg, piloting(-1200));
  assert.notEqual(d.mode, 'leave');
  assert.equal(d.nextState.importTicks, 1);
});

test('import franc RÉPÉTÉ → abandon et mise à l’écart', () => {
  let st = piloting(-1200);
  let d = decideMaxAc(enMode3({ gridW: 500 }), cfg, st);
  d = decideMaxAc(enMode3({ gridW: 500, now: T0 + 20_000 }), cfg, d.nextState);
  assert.equal(d.mode, 'leave');
  assert.match(d.reason, /ABANDON/);
  assert.ok(d.nextState.penaltyUntilTs > T0);
});

test('pendant la mise à l’écart, on ne reprend pas la barre', () => {
  const st = { ...emptyMaxAcState(), penaltyUntilTs: T0 + 60_000 };
  const d = decideMaxAc(inputs(), cfg, st);
  assert.equal(d.mode, 'idle');
  assert.match(d.reason, /mise à l’écart/);
});

test('la mise à l’écart expire et la boucle peut reprendre', () => {
  const st = { ...emptyMaxAcState(), penaltyUntilTs: T0 - 1 };
  const d = decideMaxAc(inputs(), cfg, st);
  assert.equal(d.mode, 'enter');
});

test('le compteur d’import se remet à zéro dès que le réseau redevient propre', () => {
  let d = decideMaxAc(enMode3({ gridW: 500 }), cfg, piloting(-1200));
  assert.equal(d.nextState.importTicks, 1);
  d = decideMaxAc(inputs({ gridW: 0, now: T0 + 20_000 }), cfg, d.nextState);
  assert.equal(d.nextState.importTicks, 0);
});

// ─── 6. Convergence ────────────────────────────────────────────────────────

test('en boucle fermée, la consigne converge sans jamais faire acheter', () => {
  // Modèle : maison 200 W, APS 800 W, PV SB3 disponible 1 500 W mais bridé ;
  // les SB3 couvrent l'appel jusqu'à leur maximum, le reste part en import.
  const SB3_MAX = 1500;
  let st = emptyMaxAcState();
  let pireImport = 0;
  for (let i = 0; i < 60; i++) {
    const demande = 200 + Math.max(0, -(st.setpointW ?? -600));
    const couvert = 800 + Math.min(SB3_MAX, Math.max(0, demande - 800));
    const gridW = demande - couvert;
    pireImport = Math.max(pireImport, gridW);
    const d = decideMaxAc(
      { ...inputs({ gridW, now: T0 + i * 20_000 }), maxAcMode: st.setpointW === null ? 0 : 3 },
      cfg,
      st
    );
    st = d.nextState;
  }
  assert.ok(pireImport <= cfg.abortImportW, `import maximal ${pireImport} W`);
  assert.ok((st.setpointW ?? 0) < -1000, `consigne finale ${st.setpointW}`);
});

test('exploration : à l’équilibre, la boucle POUSSE pour aller chercher le PV bridé', () => {
  const st = piloting(-600, { lastProbeTs: T0 - 120_000 });
  const d = decideMaxAc(enMode3({ gridW: -10 }), cfg, st);
  assert.equal(d.mode, 'adjust');
  assert.equal(d.writeW, -(600 + cfg.probeStepW));
  assert.match(d.reason, /palier d'essai/);
});

test('exploration : pas deux paliers coup sur coup', () => {
  const st = piloting(-600, { lastProbeTs: T0 - 5_000 });
  const d = decideMaxAc(enMode3({ gridW: -10 }), cfg, st);
  assert.equal(d.mode, 'hold');
});

test('exploration : on ne sonde pas au-delà du plafond', () => {
  const st = piloting(-cfg.maxChargeW, { lastProbeTs: T0 - 120_000 });
  const d = decideMaxAc(enMode3({ gridW: -10 }), cfg, st);
  assert.equal(d.mode, 'hold');
});

test('exploration : on ne sonde pas quand le réseau n’est PAS à l’équilibre', () => {
  const st = piloting(-600, { lastProbeTs: T0 - 60_000 });
  const d = decideMaxAc(inputs({ gridW: 200 }), cfg, st);
  assert.ok(
    d.writeW === null || d.writeW > -600,
    'un import ne doit jamais faire monter la charge'
  );
});

// ─── 7. Gardes ajoutées après la revue adversariale du 13/09 ───────────────

test('appareil resté en mode 3 alors qu’on ne pilote pas → on lui rend la régulation', () => {
  const d = decideMaxAc(inputs({ maxAcMode: 3 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'leave');
  assert.equal(d.writeW, 0);
});

test('mode 3 perdu sous nos pieds (chien de garde, app Anker) → on repart de zéro', () => {
  const d = decideMaxAc(inputs({ maxAcMode: 0 }), cfg, piloting(-1200));
  assert.equal(d.mode, 'leave');
});

test('voie cumulus muette → on rend la main (une entrée absente n’est pas un zéro)', () => {
  const d = decideMaxAc(enMode3({ cumulusW: null }), cfg, piloting(-1200));
  assert.equal(d.mode, 'leave');
  assert.match(d.reason, /muette/);
});

test('les SB3 puisent dans leur BATTERIE (sortie > PV) → on arrête', () => {
  const d = decideMaxAc(enMode3({ sb3PvW: 200, sb3OutW: 1400 }), cfg, piloting(-1200));
  assert.equal(d.mode, 'leave');
  assert.match(d.reason, /batterie/);
});

test('sortie AC ≈ PV : c’est du transit, on continue', () => {
  const d = decideMaxAc(enMode3({ sb3PvW: 1400, sb3OutW: 1400 }), cfg, piloting(-1200));
  assert.notEqual(d.mode, 'leave');
});

test('injection que la consigne ne peut PAS absorber → on rend la régulation', () => {
  const d = decideMaxAc(enMode3({ gridW: -900 }), cfg, piloting(-cfg.maxChargeW));
  assert.equal(d.mode, 'leave');
  assert.match(d.reason, /injection/);
});

test('injection que la consigne PEUT absorber → on charge plus, on ne fuit pas', () => {
  const d = decideMaxAc(enMode3({ gridW: -400 }), cfg, piloting(-600));
  assert.equal(d.mode, 'adjust');
});

test('on ne sonde JAMAIS sur un import — on le CORRIGE', () => {
  // 30 W d'achat dépasse la tolérance d'import (15 W) : la boucle réduit sa
  // charge au lieu de pousser un palier de plus.
  const st = piloting(-600, { lastProbeTs: T0 - 300_000 });
  const d = decideMaxAc(enMode3({ gridW: 30 }), cfg, st);
  assert.equal(d.mode, 'adjust');
  assert.ok(d.writeW !== null && d.writeW > -600, `la charge doit BAISSER, reçu ${d.writeW}`);
  assert.doesNotMatch(d.reason, /palier/);
});

test('on ne sonde pas non plus sur un import SOUS la tolérance', () => {
  const st = piloting(-600, { lastProbeTs: T0 - 300_000 });
  const d = decideMaxAc(enMode3({ gridW: 10 }), cfg, st);
  assert.equal(d.mode, 'hold');
});

test('on n’entre pas quand la Max AC DÉCHARGE pour couvrir la maison', () => {
  const d = decideMaxAc(inputs({ maxAcBattW: 1500 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
  assert.match(d.reason, /débite/);
});

test('on n’entre pas pendant un achat', () => {
  const d = decideMaxAc(inputs({ gridW: 200 }), cfg, emptyMaxAcState());
  assert.equal(d.mode, 'idle');
  assert.match(d.reason, /achat/);
});
