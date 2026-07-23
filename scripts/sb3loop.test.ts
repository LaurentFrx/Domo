/**
 * Tests de la loi de commande de la boucle SB3 (decide.ts, fonction pure).
 * Lancer : pnpm test:sb3loop
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/lib/server/sb3loop/decide.ts';
import {
  defaultSb3LoopConfig,
  defaultSb3LoopState,
  type Sb3LoopInputs,
  type Sb3LoopState
} from '../src/lib/server/sb3loop/types.ts';

const NOW = Date.parse('2026-07-23T22:00:00Z');
const cfg = defaultSb3LoopConfig();

function inp(o: Partial<Sb3LoopInputs> = {}): Sb3LoopInputs {
  return {
    now: NOW,
    em50: { ok: true, gridW: 20 },
    aps: { ok: true, powerW: 0 },
    maxac: { ok: true, socPct: 70, acNetW: 250 },
    cloud: {
      ok: true,
      freshS: 30,
      sb3OutW: 300,
      sb3SocAvg: 80,
      sb3PresetW: 300,
      sceneMode: 3
    },
    sunElevDeg: -15, // nuit par défaut
    ...o
  };
}

function st(o: Partial<Sb3LoopState> = {}): Sb3LoopState {
  return { ...defaultSb3LoopState(), enabled: true, ...o };
}

// ─── Fail-safe local : sans les yeux, pas de mains ───────────────────────

test('EM-50 muet → mode failsafe, aucune écriture', () => {
  const d = decide(inp({ em50: { ok: false, gridW: 0 } }), cfg, st({ lastCmdW: 900 }));
  assert.equal(d.mode, 'failsafe');
  assert.equal(d.writeW, null);
});

test('Modbus Max AC muet → mode failsafe, aucune écriture', () => {
  const d = decide(inp({ maxac: { ok: false, socPct: 0, acNetW: 0 } }), cfg, st());
  assert.equal(d.mode, 'failsafe');
  assert.equal(d.writeW, null);
});

// ─── Fail-low : cloud périmé → décroître d'un palier par cycle ───────────

test('cloud périmé + consigne haute → décroissance d’un palier (fail-low)', () => {
  const d = decide(
    inp({
      cloud: {
        ok: true,
        freshS: 600,
        sb3OutW: null,
        sb3SocAvg: null,
        sb3PresetW: null,
        sceneMode: 3
      }
    }),
    cfg,
    st({ lastCmdW: 900 })
  );
  assert.equal(d.mode, 'faillow');
  assert.equal(d.writeW, 600); // 900 − slew 300
});

test('cloud périmé + consigne déjà à 0 → rien à faire', () => {
  const d = decide(
    inp({
      cloud: {
        ok: false,
        freshS: null,
        sb3OutW: null,
        sb3SocAvg: null,
        sb3PresetW: null,
        sceneMode: null
      }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  assert.equal(d.mode, 'faillow');
  assert.equal(d.writeW, null);
});

test('fail-low respecte le dwell des baisses', () => {
  const d = decide(
    inp({
      cloud: {
        ok: true,
        freshS: 600,
        sb3OutW: null,
        sb3SocAvg: null,
        sb3PresetW: null,
        sceneMode: 3
      }
    }),
    cfg,
    st({ lastCmdW: 900, lastWriteTs: NOW - 30_000 }) // baisse < dwellDownS 60 s
  );
  assert.equal(d.mode, 'faillow');
  assert.equal(d.writeW, null); // cible calculée mais écriture retenue
  assert.equal(d.targetW, 600);
});

// ─── Mode Anker ─────────────────────────────────────────────────────────

test('scene_mode ≠ manuel → hold, écritures suspendues', () => {
  const d = decide(
    inp({
      cloud: { ok: true, freshS: 10, sb3OutW: 0, sb3SocAvg: 80, sb3PresetW: 0, sceneMode: 1 }
    }),
    cfg,
    st()
  );
  assert.equal(d.mode, 'hold');
  assert.equal(d.writeW, null);
});

// ─── Gardes et jour/nuit ────────────────────────────────────────────────

test('SB3 sous le plancher → cible 0 (écrite après 2 évaluations)', () => {
  const base = inp({
    cloud: { ok: true, freshS: 10, sb3OutW: 300, sb3SocAvg: 12, sb3PresetW: 300, sceneMode: 3 }
  });
  const d1 = decide(base, cfg, st({ lastCmdW: 300 }));
  assert.equal(d1.writeW, null); // 1re évaluation hors bande
  assert.equal(d1.pendingDeadband, 1);
  const d2 = decide(
    base,
    cfg,
    st({ lastCmdW: 300, pendingDeadband: 1, pendingDeadbandDir: 'down' })
  );
  assert.equal(d2.writeW, 0);
});

test('jour (soleil + APS) → cible 0, les SB3 chargent', () => {
  const d = decide(
    inp({ sunElevDeg: 45, aps: { ok: true, powerW: 800 } }),
    cfg,
    st({ lastCmdW: 300, pendingDeadband: 1, pendingDeadbandDir: 'down' })
  );
  assert.equal(d.mode, 'day');
  assert.equal(d.writeW, 0);
});

test('aube (soleil levé, APS faible, SB3 déchargées) → jour quand même (elles vont charger)', () => {
  const d = decide(
    inp({
      sunElevDeg: 5,
      aps: { ok: true, powerW: 20 },
      cloud: { ok: true, freshS: 10, sb3OutW: 300, sb3SocAvg: 40, sb3PresetW: 300, sceneMode: 3 }
    }),
    cfg,
    st({ lastCmdW: 300 })
  );
  assert.equal(d.mode, 'day');
});

test('crépuscule (soleil encore levé, APS éteint, SB3 pleines) → bascule nuit anticipée', () => {
  const d = decide(
    inp({
      sunElevDeg: 8,
      aps: { ok: true, powerW: 10 },
      em50: { ok: true, gridW: 30 },
      maxac: { ok: true, socPct: 80, acNetW: 400 },
      cloud: { ok: true, freshS: 10, sb3OutW: 0, sb3SocAvg: 99, sb3PresetW: 0, sceneMode: 3 }
    }),
    cfg,
    st()
  );
  assert.equal(d.mode, 'night');
});

// ─── Loi de nuit : viser SOUS la charge ─────────────────────────────────

test('nuit : cible = house_load − marge, dans la bande morte → pas d’écriture', () => {
  // house = 20 (grid) + 0 (aps) + 300 (sb3) + 200 (maxac décharge) = 520 → cible 370.
  // Consigne en place 300 : |370−300| = 70 ≤ 100 → bande morte.
  const d = decide(
    inp({ maxac: { ok: true, socPct: 70, acNetW: 200 } }),
    cfg,
    st({ lastCmdW: 300 })
  );
  assert.equal(d.mode, 'night');
  assert.equal(d.writeW, null);
  assert.equal(d.houseLoadW, 520);
});

test('nuit : écart franc → écriture après 2 évaluations, slew respecté', () => {
  const big = inp({
    em50: { ok: true, gridW: 30 },
    maxac: { ok: true, socPct: 70, acNetW: 1200 },
    cloud: { ok: true, freshS: 10, sb3OutW: 300, sb3SocAvg: 80, sb3PresetW: 300, sceneMode: 3 }
  });
  // house = 30+0+300+1200 = 1530 → cible brute 1380 ; slew depuis 300 → 600.
  const d1 = decide(big, cfg, st({ lastCmdW: 300 }));
  assert.equal(d1.writeW, null);
  assert.equal(d1.targetW, 600);
  const d2 = decide(big, cfg, st({ lastCmdW: 300, pendingDeadband: 1, pendingDeadbandDir: 'up' }));
  assert.equal(d2.writeW, 600);
});

test('anti-rétroaction : la charge Max AC (SIGNÉE) annule le transit SB3 dans house_load', () => {
  // Régime de recyclage : consigne 900 en place, maison réelle ~400 W —
  // sb3Out 900, la Max AC absorbe 500 (acNet −500), compteur ~0.
  // house = 0 + 0 + 900 − 500 = 400 = la VRAIE charge (sans le signe,
  // l'estimation aurait donné 900 = auto-confirmation du recyclage).
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 70, acNetW: -500 },
      cloud: { ok: true, freshS: 30, sb3OutW: 900, sb3SocAvg: 80, sb3PresetW: 900, sceneMode: 3 }
    }),
    cfg,
    st({ lastCmdW: 900 })
  );
  assert.equal(d.houseLoadW, 400);
  // cible brute 250, slew depuis 900 → 600 : excursion basse détectée (1/2).
  assert.equal(d.targetW, 600);
  assert.equal(d.pendingDeadband, 1);
  assert.equal(d.pendingDeadbandDir, 'down');
});

test('post-écriture (settle) : sb3Out cloud périmé remplacé par la consigne écrite', () => {
  // Écrit 600 il y a 60 s : le cloud affiche encore 300 — on substitue 600.
  const d = decide(
    inp({
      em50: { ok: true, gridW: 20 },
      maxac: { ok: true, socPct: 70, acNetW: 100 },
      cloud: { ok: true, freshS: 30, sb3OutW: 300, sb3SocAvg: 80, sb3PresetW: 600, sceneMode: 3 }
    }),
    cfg,
    st({ lastCmdW: 600, lastWriteTs: NOW - 60_000 })
  );
  // house = 20 + 0 + 600 (substitué) + 100 = 720 → cible 570 ; |570−600| = 30 ≤ 100.
  assert.equal(d.houseLoadW, 720);
  assert.equal(d.writeW, null);
});

test('bande morte directionnelle : une excursion haute puis basse ne totalise pas 2', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 70, acNetW: -500 },
      cloud: { ok: true, freshS: 30, sb3OutW: 900, sb3SocAvg: 80, sb3PresetW: 900, sceneMode: 3 }
    }),
    cfg,
    st({ lastCmdW: 900, pendingDeadband: 1, pendingDeadbandDir: 'up' }) // excursion précédente HAUTE
  );
  assert.equal(d.writeW, null); // down après up → repart à 1, pas d'écriture
  assert.equal(d.pendingDeadband, 1);
  assert.equal(d.pendingDeadbandDir, 'down');
});

test('APS injoignable en plein soleil → mode jour conservateur (pas de décharge à midi)', () => {
  const d = decide(
    inp({
      sunElevDeg: 50,
      aps: { ok: false, powerW: 0 },
      cloud: { ok: true, freshS: 30, sb3OutW: 0, sb3SocAvg: 99, sb3PresetW: 0, sceneMode: 3 }
    }),
    cfg,
    st()
  );
  assert.equal(d.mode, 'day');
});

test('dwell hausse : écriture retenue si la dernière écriture est trop récente', () => {
  const big = inp({ maxac: { ok: true, socPct: 70, acNetW: 1200 } });
  const d = decide(
    big,
    cfg,
    st({ lastCmdW: 300, pendingDeadband: 1, pendingDeadbandDir: 'up', lastWriteTs: NOW - 120_000 })
  );
  assert.equal(d.writeW, null); // hausse : dwellUpS 300 s non écoulé
  assert.equal(d.targetW, 600);
});

test('premier cycle : ancrage du slew sur la consigne vue par le cloud', () => {
  const d = decide(
    inp({
      maxac: { ok: true, socPct: 70, acNetW: 1500 },
      cloud: { ok: true, freshS: 10, sb3OutW: 0, sb3SocAvg: 90, sb3PresetW: 0, sceneMode: 3 }
    }),
    cfg,
    st({ lastCmdW: null, pendingDeadband: 1, pendingDeadbandDir: 'up' })
  );
  // house = 20+0+0+1500 = 1520 → brute 1370 ; ancrage 0 (preset cloud) → slew 300.
  assert.equal(d.writeW, 300);
});

// ─── Rescue : préserver la Max AC ───────────────────────────────────────

test('rescue : Max AC basse ET qui DÉCHARGE + SB3 chargées → la consigne suit la charge', () => {
  const d = decide(
    inp({
      sunElevDeg: 45,
      aps: { ok: true, powerW: 800 },
      em50: { ok: true, gridW: 10 },
      maxac: { ok: true, socPct: 30, acNetW: 400 }, // décharge > seuil 200 = vrai danger
      cloud: { ok: true, freshS: 10, sb3OutW: 200, sb3SocAvg: 85, sb3PresetW: 200, sceneMode: 3 }
    }),
    cfg,
    st({ lastCmdW: 200, pendingDeadband: 1, pendingDeadbandDir: 'up' })
  );
  assert.equal(d.mode, 'rescue');
  // house = 10+800+200+400 = 1410 → cible 1260 ; slew depuis 200 → 500.
  assert.equal(d.writeW, 500);
});

test('INCIDENT 23/07 : Max AC basse mais EN CHARGE (plein soleil) → PAS de rescue, jour', () => {
  // Le matin ensoleillé : Max AC à 30 % mais qui CHARGE à 2550 W (acNet −2550).
  // Elle n'est pas en danger — elle se refait. Rescue ne doit PAS drainer les
  // SB3 : mode jour, consigne 0, tout charge au soleil.
  const d = decide(
    inp({
      sunElevDeg: 45,
      aps: { ok: true, powerW: 883 },
      em50: { ok: true, gridW: 4 },
      maxac: { ok: true, socPct: 30, acNetW: -2550 }, // CHARGE
      cloud: { ok: true, freshS: 10, sb3OutW: 1200, sb3SocAvg: 40, sb3PresetW: 300, sceneMode: 3 }
    }),
    cfg,
    st({ lastCmdW: 300 })
  );
  assert.equal(d.mode, 'day');
  assert.equal(d.targetW, 0);
});

test('pas de rescue si les SB3 sont basses elles aussi', () => {
  const d = decide(
    inp({
      sunElevDeg: 45,
      aps: { ok: true, powerW: 800 },
      maxac: { ok: true, socPct: 30, acNetW: 400 },
      cloud: { ok: true, freshS: 10, sb3OutW: 0, sb3SocAvg: 20, sb3PresetW: 0, sceneMode: 3 }
    }),
    cfg,
    st()
  );
  assert.equal(d.mode, 'day'); // elles doivent charger, pas se vider
});
