/**
 * Tests de la loi de bridage APS (decide.ts, fonction pure).
 * L'installation est en autoconsommation SANS injection : la règle cardinale est
 * qu'on ne bride JAMAIS à l'aveugle ni pendant un soutirage.
 * Lancer : pnpm test:apsloop
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAps, shouldRearmAps } from '../src/lib/server/apsloop/decide.ts';
import {
  defaultApsLoopConfig,
  defaultApsLoopState,
  type ApsLoopInputs,
  type ApsLoopState
} from '../src/lib/server/apsloop/types.ts';

const cfg = defaultApsLoopConfig();
const T0 = 1_800_000_000_000;

/** État neutre : plein soleil, APS à 800 W, plafond au max, réseau équilibré. */
function inp(o: Partial<ApsLoopInputs> = {}): ApsLoopInputs {
  return {
    now: T0,
    gridW: 0,
    em50Available: true,
    apsW: 800,
    apsAvailable: true,
    apsMaxW: 960,
    apsMinLimitW: 30,
    apsMaxLimitW: 960,
    ...o
  };
}
/** État de boucle avec une écriture ancienne (hors temporisation). */
const st = (o: Partial<ApsLoopState> = {}): ApsLoopState => ({
  ...defaultApsLoopState(),
  lastWriteTs: T0 - 600_000,
  lastCmdW: 960,
  ...o
});

// ─── Sécurités (priorité absolue) ───────────────────────────────────────────

test('compteur EM-50 muet → plafond rendu au MAXIMUM (jamais de bridage aveugle)', () => {
  const d = decideAps(inp({ em50Available: false, apsMaxW: 300 }), cfg, st({ lastCmdW: 300 }));
  assert.equal(d.mode, 'failsafe');
  assert.equal(d.writeW, 960);
});

// Ce test affirmait « endormi → on écrit 960 W ». C'est ce comportement qui a
// éteint la protection le 12/08/2026 : l'écriture partait vers un onduleur
// coupé, n'était jamais confirmée, et deux ticks suffisaient à la désarmer.
// Le plafond est un bail de 600 s côté pont : il retombe seul au maximum.
test('onduleur endormi (nuit) → on n’écrit RIEN, le bail rend le plafond seul', () => {
  const d = decideAps(
    inp({ apsAvailable: false, apsW: 0, apsMaxW: 200 }),
    cfg,
    st({ lastCmdW: 200 })
  );
  assert.equal(d.mode, 'night');
  assert.equal(d.writeW, null);
  assert.equal(d.targetW, 960, 'la cible reste le maximum — c’est l’écriture qui est inutile');
});

test('SOUTIRAGE EDF → plafond au maximum, jamais de bridage pendant un import', () => {
  const d = decideAps(inp({ gridW: 400, apsMaxW: 300 }), cfg, st({ lastCmdW: 300 }));
  assert.equal(d.mode, 'import');
  assert.equal(d.writeW, 960);
});

test('soutirage MÊME faible (10 W) → on remonte : ne jamais payer pour brider du gratuit', () => {
  const d = decideAps(inp({ gridW: 10, apsMaxW: 400 }), cfg, st({ lastCmdW: 400 }));
  assert.equal(d.mode, 'import');
  assert.equal(d.writeW, 960);
});

// ─── Bridage sur injection ──────────────────────────────────────────────────

test('injection NON soutenue → on attend (on laisse la Max AC réguler d’abord)', () => {
  const d = decideAps(inp({ gridW: -400 }), cfg, st());
  assert.equal(d.mode, 'hold');
  assert.equal(d.writeW, null);
  assert.notEqual(d.nextState.exportSinceTs, null); // chrono armé
});

test('injection soutenue → plafond = production − excédent − marge', () => {
  const s = st({ exportSinceTs: T0 - 120_000 }); // injecte depuis 2 min
  const d = decideAps(inp({ gridW: -400, apsW: 800 }), cfg, s);
  assert.equal(d.mode, 'throttle');
  assert.equal(d.writeW, 800 - 400 - 50); // 350 W
});

test('injection massive → plafond borné au minimum de l’appareil (30 W)', () => {
  const s = st({ exportSinceTs: T0 - 120_000 });
  const d = decideAps(inp({ gridW: -900, apsW: 900 }), cfg, s);
  assert.equal(d.mode, 'throttle');
  assert.equal(d.writeW, 30);
});

test('le chrono d’injection se réarme à zéro dès que le réseau redevient propre', () => {
  const s = st({ exportSinceTs: T0 - 30_000 });
  const d = decideAps(inp({ gridW: -10 }), cfg, s);
  assert.equal(d.nextState.exportSinceTs, null);
});

// ─── Remontée ───────────────────────────────────────────────────────────────

test('réseau propre → remontée par PALIERS (pas de retour brutal au maximum)', () => {
  const d = decideAps(inp({ gridW: -10, apsMaxW: 400 }), cfg, st({ lastCmdW: 400 }));
  assert.equal(d.mode, 'raise');
  assert.equal(d.writeW, 550); // +150, pas 960
});

test('la remontée doit être FRANCHE : retour au maximum en quelques minutes', () => {
  // Défaut constaté en observation (27/07) : bridé à 30 W, la maison consomme et
  // c'est la BATTERIE qui la couvre — donc aucun import, donc aucun signal. Une
  // remontée trop lente ferait brûler de la batterie à la place du solaire gratuit.
  let cap = 30;
  let steps = 0;
  while (cap < 960 && steps < 50) {
    const d = decideAps(inp({ gridW: -10, apsMaxW: cap }), cfg, st({ lastCmdW: cap }));
    if (d.writeW === null) break;
    cap = d.writeW;
    steps++;
  }
  assert.equal(cap, 960);
  // 1 palier / 60 s ⇒ steps = minutes pour revenir au plein régime.
  assert.ok(steps <= 8, `retour au maximum en ${steps} min, trop lent`);
});

test('remontée respectée par la temporisation (pas de rafale d’écritures)', () => {
  const s = st({ lastWriteTs: T0 - 10_000, lastCmdW: 400 }); // écrit il y a 10 s
  const d = decideAps(inp({ gridW: -10, apsMaxW: 400 }), cfg, s);
  assert.equal(d.mode, 'hold');
  assert.equal(d.writeW, null);
});

test('plafond déjà au maximum + réseau propre → aucune écriture', () => {
  const d = decideAps(inp({ gridW: -10, apsMaxW: 960 }), cfg, st());
  assert.equal(d.writeW, null);
});

// ─── Amortisseurs ───────────────────────────────────────────────────────────

test('bande morte : un écart insignifiant ne déclenche pas d’écriture', () => {
  const s = st({ exportSinceTs: T0 - 120_000 });
  // cible = 800 − 160 − 50 = 590 ; plafond courant 600 → écart 10 W < 25
  const d = decideAps(inp({ gridW: -160, apsW: 800, apsMaxW: 600 }), cfg, s);
  assert.equal(d.writeW, null);
});

test('zone intermédiaire (injection tolérée) → on ne touche à rien', () => {
  const d = decideAps(inp({ gridW: -100, apsMaxW: 500 }), cfg, st({ lastCmdW: 500 }));
  assert.equal(d.mode, 'hold');
  assert.equal(d.writeW, null);
});

test('la cible reste TOUJOURS dans les bornes de l’appareil', () => {
  const s = st({ exportSinceTs: T0 - 120_000 });
  for (const g of [-5000, -900, -200, 0, 500]) {
    const d = decideAps(inp({ gridW: g, apsW: 900 }), cfg, s);
    if (d.writeW !== null) {
      assert.ok(d.writeW >= 30, `${d.writeW} < min`);
      assert.ok(d.writeW <= 960, `${d.writeW} > max`);
    }
  }
});

// ─── Régression 12/08/2026 : la protection s'est éteinte toute seule ────────
// L'onduleur EZ1 se coupe quand il ne produit plus. Le tick lui écrivait quand
// même « plafond au maximum », le pont ne pouvait pas confirmer, deux ticks
// suffisaient à compter deux échecs → auto-désactivation, puis 17 jours
// d'injection non bridée. ENDORMI ≠ REFUS.

test('onduleur endormi : AUCUNE écriture (sinon deux échecs = protection coupée)', () => {
  const d = decideAps(inp({ apsAvailable: false, apsW: 0, gridW: -900 }), cfg, st());
  assert.equal(d.mode, 'night');
  assert.equal(d.writeW, null, 'écrire sur un onduleur éteint = un échec de confirmation garanti');
});

test('onduleur endormi : le compte d’injection est remis à zéro', () => {
  const s = st({ exportSinceTs: T0 - 600_000 });
  const d = decideAps(inp({ apsAvailable: false, apsW: 0, gridW: -900 }), cfg, s);
  assert.equal(d.nextState.exportSinceTs, null);
});

test('onduleur réveillé : le bridage repart normalement', () => {
  const s = st({ exportSinceTs: T0 - 120_000 });
  const d = decideAps(inp({ apsAvailable: true, apsW: 800, gridW: -900 }), cfg, s);
  assert.ok(d.writeW !== null && d.writeW < 960, 'injection soutenue → plafond abaissé');
});

// ─── Réarmement automatique (consigne : aucune réinjection, jamais de pause) ─

const REARM = { delayMs: 15 * 60_000, maxPerDay: 4 };
const awake = { available: true, writeEnabled: true, powerW: 400 };
const down = (o: Partial<typeof awake> = {}) => ({ ...awake, ...o });

test('arrêt MANUEL : jamais contourné', () => {
  const v = shouldRearmAps(
    { autoDisabledReason: null, autoDisabledTs: T0, rearmCount: 0 },
    T0 + 3_600_000,
    awake,
    REARM
  );
  assert.equal(v.rearm, false);
});

test('arrêt de sécurité : pas de réarmement avant le délai', () => {
  const v = shouldRearmAps(
    { autoDisabledReason: 'plafond non appliqué 2×', autoDisabledTs: T0, rearmCount: 0 },
    T0 + 60_000,
    awake,
    REARM
  );
  assert.equal(v.rearm, false);
});

test('arrêt de sécurité : réarmement une fois le délai passé et l’onduleur éveillé', () => {
  const v = shouldRearmAps(
    { autoDisabledReason: 'plafond non appliqué 2×', autoDisabledTs: T0, rearmCount: 0 },
    T0 + 16 * 60_000,
    awake,
    REARM
  );
  assert.equal(v.rearm, true);
});

test('on ne réarme PAS sur un onduleur endormi (ce serait rejouer la panne)', () => {
  for (const aps of [
    down({ powerW: 0 }),
    down({ available: false }),
    down({ writeEnabled: false }),
    null
  ]) {
    const v = shouldRearmAps(
      { autoDisabledReason: 'plafond non appliqué 2×', autoDisabledTs: T0, rearmCount: 0 },
      T0 + 16 * 60_000,
      aps,
      REARM
    );
    assert.equal(v.rearm, false, `réarmé à tort sur ${JSON.stringify(aps)}`);
  }
});

test('quota journalier : on cesse d’insister après 4 réarmements', () => {
  const v = shouldRearmAps(
    { autoDisabledReason: 'plafond non appliqué 2×', autoDisabledTs: T0, rearmCount: 4 },
    T0 + 16 * 60_000,
    awake,
    REARM
  );
  assert.equal(v.rearm, false);
});

test('état sans horloge d’arrêt (ancienne version) : daté d’abord, réarmé ensuite', () => {
  const v = shouldRearmAps(
    { autoDisabledReason: 'plafond non appliqué 2×', autoDisabledTs: null, rearmCount: 0 },
    T0,
    awake,
    REARM
  );
  assert.equal(v.rearm, false);
  assert.match(v.note ?? '', /programmé/);
});
