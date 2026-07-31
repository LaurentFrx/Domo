/**
 * Tests de la loi de commande de la boucle SB3 (decide.ts, fonction pure).
 * Lancer : pnpm test:sb3loop
 *
 * Les règles ABSOLUES de Laurent (28/07/2026) sont testées en premier — ce sont
 * elles qui priment sur tout le reste :
 *   1. ne JAMAIS soutirer sur EDF ; aucune convention ne bloque la décharge
 *   2. répartition au PRORATA de l'énergie utilisable (réserve 10 % déduite)
 *   3. aucun palier, aucune réaction différée
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, usableWh } from '../src/lib/server/sb3loop/decide.ts';
import {
  defaultSb3LoopConfig,
  defaultSb3LoopState,
  type Sb3LoopInputs,
  type Sb3LoopState
} from '../src/lib/server/sb3loop/types.ts';

const NOW = Date.parse('2026-07-28T15:00:00Z');
const cfg = defaultSb3LoopConfig();

/** Deux SB3 E2700 Pro (2 688 Wh chacune) au même SoC. */
const packs = (socPct: number, capacityWh = 2688) => [
  { socPct, capacityWh },
  { socPct, capacityWh }
];

function inp(o: Partial<Sb3LoopInputs> = {}): Sb3LoopInputs {
  return {
    now: NOW,
    em50: { ok: true, gridW: 0 },
    aps: { ok: true, powerW: 0 },
    maxac: { ok: true, socPct: 60, acNetW: 500, ratedEnergyWh: 7200 },
    cloud: {
      ok: true,
      freshS: 30,
      sb3OutW: 0,
      sb3SocAvg: 100,
      sb3Packs: packs(100),
      sb3PresetW: 0,
      sb3PvW: 0,
      sceneMode: 3
    },
    sunElevDeg: 50,
    ...o
  };
}

const st = (o: Partial<Sb3LoopState> = {}): Sb3LoopState => ({
  ...defaultSb3LoopState(),
  enabled: true,
  ...o
});

// ─── RÈGLE 1 — ne jamais soutirer sur EDF ────────────────────────────────

test('RÈGLE 1 : un soutirage mesuré est couvert INTÉGRALEMENT, pas au prorata', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 1500 }, // 1,5 kW achetés à EDF, maintenant
      maxac: { ok: true, socPct: 60, acNetW: 2000, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0 }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  assert.equal(d.mode, 'allocate');
  assert.ok(
    (d.writeW ?? 0) >= 1500,
    `la cible doit couvrir au moins le soutirage (obtenu ${d.writeW})`
  );
});

test('RÈGLE 1 : batteries PLEINES en plein soleil → elles débitent, jamais de consigne 0', () => {
  // Le cas exact du 28/07 : cumulus 3 kW, SB3 à 100 %, soleil haut.
  const d = decide(
    inp({
      sunElevDeg: 55,
      aps: { ok: true, powerW: 650 },
      em50: { ok: true, gridW: 900 },
      maxac: { ok: true, socPct: 73, acNetW: 1900, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3Packs: packs(100), sb3SocAvg: 100 }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  assert.ok((d.writeW ?? 0) > 0, 'aucune règle « jour » ne doit bloquer la décharge');
});

test('RÈGLE 1 : le plein soleil ne change RIEN à la loi (plus de mode jour)', () => {
  const commun = {
    em50: { ok: true, gridW: 0 },
    maxac: { ok: true, socPct: 60, acNetW: 500, ratedEnergyWh: 7200 },
    cloud: { ...inp().cloud, sb3OutW: 800 }
  };
  const jour = decide(inp({ ...commun, sunElevDeg: 55 }), cfg, st({ lastCmdW: 0 }));
  const nuit = decide(inp({ ...commun, sunElevDeg: -20 }), cfg, st({ lastCmdW: 0 }));
  assert.equal(jour.writeW, nuit.writeW);
});

// ─── RÈGLE 2 — prorata de l'énergie utilisable ───────────────────────────

test('utilisable = capacité × (SoC − réserve), jamais négatif', () => {
  assert.equal(usableWh(100, 2688, 10), (2688 * 90) / 100);
  assert.equal(usableWh(10, 2688, 10), 0);
  assert.equal(usableWh(5, 2688, 10), 0, 'sous la réserve : rien à donner');
  assert.equal(usableWh(60, 7200, 10), (7200 * 50) / 100);
});

test('RÈGLE 2 : la part suit le prorata d’énergie utilisable', () => {
  // SB3 : 2 × 2688 × 0,9 = 4 838,4 Wh ; Max AC : 7 200 × 0,5 = 3 600 Wh
  // Compteur à l'équilibre → on répartit les 2 000 W de batterie au prorata.
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      // acNetW faible : on teste le RATIO, pas la borne de marge Max AC.
      maxac: { ok: true, socPct: 60, acNetW: 200, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 800, sb3Packs: packs(100) }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  // La cible de partage est approchée par fractions (shareGain) pour ne pas
  // bousculer l'équilibre du compteur : on vérifie la CONVERGENCE, pas un saut.
  const attendu = 1000 * (4838.4 / (4838.4 + 3600));
  let u = 0;
  for (let i = 0; i < 40; i++) {
    const r = decide(
      inp({
        em50: { ok: true, gridW: 0 },
        maxac: { ok: true, socPct: 60, acNetW: 200, ratedEnergyWh: 7200 },
        cloud: { ...inp().cloud, sb3OutW: 800, sb3Packs: packs(100) }
      }),
      cfg,
      st({ lastCmdW: u })
    );
    u = r.writeW ?? u;
  }
  // précision attendue = deadbandW / shareGain
  const tol = cfg.deadbandW / cfg.shareGain + 10;
  assert.ok(Math.abs(u - attendu) <= tol, `converge vers ~${Math.round(attendu)} W, obtenu ${u}`);
  assert.ok((d.writeW ?? 0) > 0 && (d.writeW ?? 0) < attendu, 'premier pas partiel');
});

test('RÈGLE 2 : Max AC à sa réserve → les SB3 prennent TOUT (part 100 %)', () => {
  const d = decide(
    inp({
      maxac: { ok: true, socPct: 10, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 1000, sb3Packs: packs(80) }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  let u = 0;
  for (let i = 0; i < 40; i++) {
    const r = decide(
      inp({
        maxac: { ok: true, socPct: 10, acNetW: 0, ratedEnergyWh: 7200 },
        cloud: { ...inp().cloud, sb3OutW: 1000, sb3Packs: packs(80) }
      }),
      cfg,
      st({ lastCmdW: u })
    );
    u = r.writeW ?? u;
  }
  assert.ok(
    Math.abs(u - 1000) <= cfg.deadbandW / cfg.shareGain + 10,
    `la Max AC ne peut plus rien : converge vers 1000, obtenu ${u}`
  );
  assert.ok((d.writeW ?? 0) > 0, 'premier pas dans le bon sens');
});

test('RÈGLE 2 : SB3 à leur réserve → part 0, la Max AC assume', () => {
  const d = decide(
    inp({
      maxac: { ok: true, socPct: 80, acNetW: 1000, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0, sb3Packs: packs(10), sb3SocAvg: 10 }
    }),
    cfg,
    st({ lastCmdW: 500 })
  );
  assert.equal(d.writeW, 0);
});

test('RÈGLE 2 : deux packs DÉSÉQUILIBRÉS comptent chacun pour leur propre reste', () => {
  const plein = decide(
    inp({
      maxac: { ok: true, socPct: 60, acNetW: 200, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 800, sb3Packs: packs(100) }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  const boiteux = decide(
    inp({
      maxac: { ok: true, socPct: 60, acNetW: 200, ratedEnergyWh: 7200 },
      cloud: {
        ...inp().cloud,
        sb3OutW: 800,
        sb3Packs: [
          { socPct: 100, capacityWh: 2688 },
          { socPct: 10, capacityWh: 2688 } // vide : ne contribue pas
        ]
      }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  assert.ok(
    (boiteux.writeW ?? 0) < (plein.writeW ?? 0),
    'un pack vide doit réduire la part SB3, pas être noyé dans une moyenne'
  );
});

test('parc entièrement à plat → consigne 0 (rien à répartir)', () => {
  const d = decide(
    inp({
      maxac: { ok: true, socPct: 8, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0, sb3Packs: packs(9), sb3SocAvg: 9 }
    }),
    cfg,
    st({ lastCmdW: 400 })
  );
  assert.equal(d.writeW, 0);
});

// ─── RÈGLE 3 — aucun palier, aucune réaction différée ────────────────────

test('RÈGLE 3 : un échelon de charge est suivi EN UNE SEULE écriture', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 2500 }, // le cumulus vient de démarrer
      maxac: { ok: true, socPct: 10, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0, sb3Packs: packs(100) }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  assert.equal(d.writeW, cfg.maxPresetW, 'plein régime immédiat, pas un palier');
});

test('RÈGLE 3 : aucune temporisation — une écriture à l’instant précédent ne bloque pas', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 2000 },
      maxac: { ok: true, socPct: 10, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0 }
    }),
    cfg,
    st({ lastCmdW: 0, lastWriteTs: NOW - 1000 }) // écrit il y a 1 s
  );
  assert.ok((d.writeW ?? 0) > 0, 'plus de dwell : la charge n’attend pas');
});

test('RÈGLE 3 : la BAISSE est immédiate aussi (l’excédent finirait chez EDF)', () => {
  const d = decide(
    inp({
      // injection RÉELLE (au-delà de la bande morte) : c'est le chemin « erreur
      // compteur » qu'on teste, et lui n'est jamais borné — la règle 1 prime.
      em50: { ok: true, gridW: -800 },
      maxac: { ok: true, socPct: 60, acNetW: -1500, ratedEnergyWh: 7200 }, // absorbe
      cloud: { ...inp().cloud, sb3OutW: 2400, sb3Packs: packs(100) }
    }),
    cfg,
    st({ lastCmdW: 2400 })
  );
  assert.ok((d.writeW ?? 0) < 2400 - 500, `descente franche attendue, obtenu ${d.writeW}`);
});

test('bande morte : une variation < deadbandW n’écrit pas (résolution, pas délai)', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 10, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 980 }
    }),
    cfg,
    st({ lastCmdW: 900 })
  );
  assert.equal(d.writeW, null);
  assert.equal(d.mode, 'allocate');
});

// ─── Fail-safe / fail-low / mode Anker (inchangés) ───────────────────────

test('EM-50 muet → failsafe, aucune écriture', () => {
  const d = decide(inp({ em50: { ok: false, gridW: 0 } }), cfg, st({ lastCmdW: 900 }));
  assert.equal(d.mode, 'failsafe');
  assert.equal(d.writeW, null);
});

test('Modbus Max AC muet → failsafe, aucune écriture', () => {
  const d = decide(
    inp({ maxac: { ok: false, socPct: 0, acNetW: 0, ratedEnergyWh: 0 } }),
    cfg,
    st()
  );
  assert.equal(d.mode, 'failsafe');
  assert.equal(d.writeW, null);
});

test('cloud périmé + consigne haute → décroissance d’un palier (seul palier admis)', () => {
  const d = decide(
    inp({ cloud: { ...inp().cloud, ok: true, freshS: 600 } }),
    cfg,
    st({ lastCmdW: 1200, lastWriteTs: NOW - 400_000 })
  );
  assert.equal(d.mode, 'faillow');
  assert.equal(d.writeW, 1200 - cfg.failLowStepW);
});

test('mode Anker ≠ manuel → hold, aucune écriture', () => {
  const d = decide(inp({ cloud: { ...inp().cloud, sceneMode: 1 } }), cfg, st({ lastCmdW: 500 }));
  assert.equal(d.mode, 'hold');
  assert.equal(d.writeW, null);
});

test('la cible ne dépasse jamais maxPresetW', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 5000 },
      maxac: { ok: true, socPct: 10, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0 }
    }),
    cfg,
    st({ lastCmdW: 0 })
  );
  assert.equal(d.writeW, cfg.maxPresetW);
});

test('settle : juste après une écriture, sb3Out est remplacé par la consigne écrite', () => {
  // sb3Out cloud encore à 0 alors qu'on vient d'écrire 1500 : sans settle la
  // charge serait sous-estimée de 1 500 W et la boucle chasserait son retard.
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 10, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0 }
    }),
    cfg,
    st({ lastCmdW: 1500, lastWriteTs: NOW - 10_000 })
  );
  assert.equal(d.houseLoadW, 1500);
});

// ─── PRÉDICTEUR DE SMITH — le retard ne doit pas faire compter deux fois ──
// Mesuré en service le 28/07 : à gain plein sans prédicteur, la boucle entrait
// en cycle limite de période 2 min (soutirage 800 → injection 786 → soutirage
// 814 W…), 864 écritures/jour. Théorie : z^{d+1} − z^d + K = 0, |z| = √K à d=1
// ⇒ K=1 place les racines SUR le cercle unité. Cf. docs/regulation-energie.md.

test('SMITH : une correction déjà commandée est retranchée de l’erreur mesurée', () => {
  // Le compteur montre encore 800 W de soutirage, mais on a déjà commandé +800 W
  // au tick précédent : l'erreur EFFECTIVE est nulle, il ne faut PAS réécrire.
  const d = decide(
    inp({
      em50: { ok: true, gridW: 800 },
      maxac: { ok: true, socPct: 60, acNetW: 500, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200 }
    }),
    cfg,
    // Une correction EN VOL implique une écriture récente : la fixture doit être
    // cohérente, sinon c'est le chemin « partage » (non urgent) qu'on teste.
    st({ lastCmdW: 1000, lastWriteTs: NOW - 5_000, enVol: [{ ts: NOW - 5_000, dW: 800 }] })
  );
  assert.equal(d.writeW, null, 'ne pas commander deux fois la même correction');
});

test('SMITH : sans correction en vol, l’erreur mesurée est suivie en plein', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 800 },
      maxac: { ok: true, socPct: 60, acNetW: 500, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200 }
    }),
    cfg,
    st({ lastCmdW: 1000, enVol: [] })
  );
  assert.equal(d.writeW, 1800, 'correction pleine et immédiate (règle 3)');
});

test('SMITH : une correction PÉRIMÉE ne bloque plus rien', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 800 },
      maxac: { ok: true, socPct: 60, acNetW: 500, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200 }
    }),
    cfg,
    st({ lastCmdW: 1000, enVol: [{ ts: NOW - 120_000, dW: 800 }] })
  );
  assert.equal(d.writeW, 1800, 'au-delà de enVolS, le compteur a vu : on agit');
});

test('SMITH : toute écriture alimente la file des corrections en vol', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 900 },
      maxac: { ok: true, socPct: 60, acNetW: 500, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 0 }
    }),
    cfg,
    st({ lastCmdW: 0, enVol: [] })
  );
  assert.equal(d.enVol.length, 1);
  assert.equal(d.enVol[0].dW, d.writeW);
});

test('SMITH : les corrections en vol se CUMULENT', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 900 },
      maxac: { ok: true, socPct: 60, acNetW: 500, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200 }
    }),
    cfg,
    st({
      lastCmdW: 1000,
      lastWriteTs: NOW - 5_000,
      enVol: [
        { ts: NOW - 5_000, dW: 500 },
        { ts: NOW - 10_000, dW: 400 }
      ]
    })
  );
  assert.equal(d.writeW, null, '900 W déjà en vol couvrent les 900 W mesurés');
});

test('le rééquilibrage ne dépasse jamais la marge de puissance de la Max AC', () => {
  // Max AC déjà à 1 870 W sur 2 000 : elle ne peut reprendre que 130 W de plus.
  // Le prorata voudrait baisser la consigne de bien plus — ce serait du soutirage.
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 40, acNetW: 1870, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 2400, sb3Packs: packs(100) }
    }),
    cfg,
    st({ lastCmdW: 2400 })
  );
  const marge = cfg.maxAcPowerW - 1870;
  assert.ok(
    d.writeW === null || d.writeW >= 2400 - marge - 1,
    `baisse limitée à ${marge} W, obtenu ${d.writeW}`
  );
});

// ─── RÈGLE 0 — la PUISSANCE du parc doit rester disponible ───────────────
// 31/07 : SB3 à 44/45 %, Max AC à 10 %. Même stock (1 854 Wh), mais 2 400 W
// mobilisables au lieu de 5 940 — et 800 W achetés à EDF. Le prorata en
// décharge CONSERVE le déséquilibre (invariant) : seule la recharge répare.

test('RÈGLE 0 : Max AC en retard + PV gardé par les SB3 → on DÉTOURNE vers elle', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 }, // règle 1 servie
      maxac: { ok: true, socPct: 15, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200, sb3PvW: 1400, sb3Packs: packs(80) }
    }),
    cfg,
    st({ lastCmdW: 200 })
  );
  assert.ok((d.writeW ?? 0) > 200, `la consigne doit MONTER pour détourner (obtenu ${d.writeW})`);
  assert.match(d.reason, /RÉÉQUILIBRAGE/);
});

test('RÈGLE 0 : parc déjà équilibré → aucun détour (le détour coûte une conversion)', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 80, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200, sb3PvW: 1400, sb3Packs: packs(80) }
    }),
    cfg,
    st({ lastCmdW: 200 })
  );
  assert.doesNotMatch(d.reason, /RÉÉQUILIBRAGE/);
});

test('RÈGLE 0 : pas de PV gardé → rien à détourner, on ne s’agite pas', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 15, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 1400, sb3PvW: 1400, sb3Packs: packs(80) }
    }),
    cfg,
    st({ lastCmdW: 1400 })
  );
  assert.doesNotMatch(d.reason, /RÉÉQUILIBRAGE/);
});

test('RÈGLE 1 PRIME sur la règle 0 : un soutirage passe avant le rééquilibrage', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 900 }, // on achète : priorité absolue
      maxac: { ok: true, socPct: 15, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200, sb3PvW: 1400, sb3Packs: packs(80) }
    }),
    cfg,
    st({ lastCmdW: 200 })
  );
  assert.match(d.reason, /SOUTIRAGE/);
});

test('RÈGLE 0 : le détour est PROGRESSIF, il ne saute pas sur la cible', () => {
  const d = decide(
    inp({
      em50: { ok: true, gridW: 0 },
      maxac: { ok: true, socPct: 15, acNetW: 0, ratedEnergyWh: 7200 },
      cloud: { ...inp().cloud, sb3OutW: 200, sb3PvW: 1400, sb3Packs: packs(80) }
    }),
    cfg,
    st({ lastCmdW: 200 })
  );
  assert.ok((d.writeW ?? 0) < 200 + 1200, 'pas de saut sur la totalité du PV gardé');
});
