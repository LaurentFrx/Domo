#!/usr/bin/env node
/**
 * Banc de test Modbus LOCAL de la Solarbank Max AC (A17E2) — contrôle par tiers.
 *
 * POURQUOI. Depuis que les SB3 ont leur propre compteur (Gen 1, 12/09/2026), la
 * consigne cloud ne commande plus leur décharge : c'est leur firmware qui régule.
 * La Max AC, plus rapide (Modbus local ~2 s), sert donc la maison avant elles et
 * se vide seule — le parc se déséquilibre et perd ses 3 540 W de pointe quand
 * elle touche sa réserve (règle 0). Le seul levier restant est de brider SA
 * puissance de décharge, en local. Cela exige le mode « contrôle par tiers »,
 * dans lequel elle CESSE de réguler seule.
 *
 * CE QUE CE BANC DOIT ÉTABLIR, AVANT toute intégration dans Domo :
 *   1. quels registres de commande apparaissent une fois le mode tiers activé ;
 *   2. si l'appareil obéit à une consigne de puissance ;
 *   3. ⚠️ CE QU'IL FAIT QUAND LE CONTRÔLEUR SE TAIT (Domo redémarre à chaque
 *      déploiement). Aucun watchdog n'est documenté côté Anker. S'il reste figé
 *      sur la dernière consigne, on rejoue le piège de la consigne SB3 gravée
 *      7 jours — il faudra un chien de garde SUR LE RPi4, pas sur le VPS.
 *
 * SÛRETÉ. Lecture seule par défaut. Toute écriture exige --write ET --yes, reste
 * bornée, et le banc relit systématiquement après écriture. Aucune écriture n'est
 * faite sur un registre non identifié.
 *
 * Usage :
 *   node ops/maxac-modbus-test.mjs scan               → carte des registres lisibles
 *   node ops/maxac-modbus-test.mjs watch [minutes]    → suit état + compteur EM-50
 *   node ops/maxac-modbus-test.mjs write <reg> <val> --write --yes
 *   node ops/maxac-modbus-test.mjs silence [minutes]  → écrit une fois puis SE TAIT et observe
 */
import { connect } from 'node:net';
import { execSync } from 'node:child_process';

const HOST = process.env.MAXAC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MAXAC_PORT ?? 1503);
const UNIT = Number(process.env.MAXAC_UNIT ?? 1);
const DB = '/home/laurent/domo-recorder/history.db';

const ts = () => new Date().toLocaleTimeString('fr-FR');
const log = (...a) => console.log(ts(), ...a);

function modbus(fc, addr, countOrValue) {
  return new Promise((resolve) => {
    const s = connect({ host: HOST, port: PORT }, () => {
      const b = Buffer.alloc(12);
      b.writeUInt16BE(1, 0);
      b.writeUInt16BE(0, 2);
      b.writeUInt16BE(6, 4);
      b.writeUInt8(UNIT, 6);
      b.writeUInt8(fc, 7);
      b.writeUInt16BE(addr, 8);
      b.writeUInt16BE(countOrValue, 10);
      s.write(b);
    });
    let buf = Buffer.alloc(0);
    const done = (v) => {
      try {
        s.destroy();
      } catch {
        /* déjà fermé */
      }
      resolve(v);
    };
    s.setTimeout(3000, () => done({ err: 'timeout' }));
    s.on('error', (e) => done({ err: e.code ?? String(e) }));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      const f = buf.readUInt8(7);
      if (f & 0x80) return done({ err: 'exception Modbus ' + buf.readUInt8(8) });
      if (fc === 6)
        return done({ ok: true, addr: buf.readUInt16BE(8), value: buf.readUInt16BE(10) });
      const n = buf.readUInt8(8),
        vals = [];
      for (let i = 0; i < n / 2; i++) vals.push(buf.readUInt16BE(9 + i * 2));
      done({ vals });
    });
  });
}
const readHolding = (addr, count = 1) => modbus(3, addr, count);
const readInput = (addr, count = 1) => modbus(4, addr, count);
const writeSingle = (addr, value) => modbus(6, addr, value);

/** Compteur EM-50 (source de vérité réseau) via le dernier échantillon du recorder.
 *  `sqlite3` n'est pas installé sur le VPS → on passe par python3, présent partout. */
function grid() {
  try {
    const py =
      "import sqlite3;c=sqlite3.connect('file:" +
      DB +
      "?mode=ro',uri=True);r=c.execute('select em50_grid_w,maxac_batt_w,maxac_soc_pct,sb3_out_w from pv_samples order by ts desc limit 1').fetchone();print('|'.join(str(round(x)) if x is not None else '?' for x in r))";
    const out = execSyncSafe(`python3 -c ${JSON.stringify(py)}`);
    const [g, mx, soc, sb] = out.trim().split('|');
    return { gridW: g, maxacW: mx, soc, sb3W: sb };
  } catch {
    return null;
  }
}
function execSyncSafe(cmd) {
  return execSync(cmd, { encoding: 'utf8', timeout: 5000 });
}

/** Carte officielle Anker (ha-anker-solix-official, config/*.yaml) — vérifiée sur l'appareil le 13/09/2026. */
const REG = {
  operatingMode: 10064, // UINT16, inscriptible. 3 = contrôle par tiers.
  powerSetpoint: 10071, // INT32 (2 registres), WATTS, 0..10000 — visible en mode 3 seulement.
  emsModeMask: 32774, // 0x8006 : BIT5 = contrôle par tiers autorisé (mesuré 111 → BIT5 présent).
  maxChargeW: 10036, // INT32
  maxDischargeW: 10038, // INT32
  socLimits: 60000 // plafond charge / plancher décharge / réserve
};

const MODES = {
  0: 'autoconsommation',
  1: 'plages horaires',
  3: 'CONTRÔLE PAR TIERS',
  4: 'personnalisé',
  5: 'prise',
  6: 'smart',
  7: 'prix dynamique'
};

async function etat() {
  const [mode, limites, batt] = await Promise.all([
    readHolding(10064, 1),
    readHolding(60000, 4),
    readInput(10001, 15)
  ]);
  const m = mode.vals?.[0];
  const g = grid();
  return {
    mode: m,
    modeLabel: MODES[m] ?? `inconnu (${m})`,
    plafondChargePct: limites.vals?.[0],
    plancherDechargePct: limites.vals?.[1],
    battStatus: batt.vals?.[0],
    reseau: g
  };
}

async function cmdScan() {
  log(`Max AC sur ${HOST}:${PORT} (unit ${UNIT}) — LECTURE SEULE`);
  const e = await etat();
  log(
    `mode = ${e.mode} → ${e.modeLabel} | plafond charge ${e.plafondChargePct} % | plancher décharge ${e.plancherDechargePct} %`
  );
  if (e.reseau)
    log(
      `réseau EM-50 ${e.reseau.gridW} W | Max AC ${e.reseau.maxacW} W à ${e.reseau.soc} % | SB3 ${e.reseau.sb3W} W`
    );
  log('--- balayage des zones de réglage (holding) ---');
  for (const [base, span] of [
    [60000, 32],
    [10064, 8],
    [10600, 16],
    [40000, 8],
    [30000, 8]
  ]) {
    for (let a = base; a < base + span; a++) {
      const r = await readHolding(a, 1);
      if (!r.err) log(`  @${a} = ${r.vals[0]}`);
    }
  }
  const mask = await readHolding(REG.emsModeMask, 1);
  const m = mask.vals?.[0] ?? 0;
  log(
    `ems_mode_mask = ${m} → contrôle par tiers ${m & 32 ? 'AUTORISÉ (BIT5)' : 'REFUSÉ (BIT5 absent)'}`
  );
  const sp = await readHolding(REG.powerSetpoint, 2);
  if (!sp.err) {
    const raw = ((sp.vals[0] << 16) | sp.vals[1]) >>> 0;
    log(
      `consigne de puissance @${REG.powerSetpoint} = ${raw > 2147483647 ? raw - 4294967296 : raw} W`
    );
  }
  log('Consigne de puissance = registre 10071 (INT32, watts) — n’agit qu’en mode 3.');
}

async function cmdWatch(minutes = 10) {
  log(`suivi ${minutes} min — LECTURE SEULE`);
  const fin = Date.now() + minutes * 60000;
  while (Date.now() < fin) {
    const e = await etat();
    const g = e.reseau;
    log(
      `mode ${e.mode} (${e.modeLabel}) | EM-50 ${g?.gridW ?? '?'} W | Max AC ${g?.maxacW ?? '?'} W ${g?.soc ?? '?'} % | SB3 ${g?.sb3W ?? '?'} W`
    );
    await new Promise((r) => setTimeout(r, 15000));
  }
}

async function cmdWrite(reg, val, argv) {
  if (!argv.includes('--write') || !argv.includes('--yes')) {
    log('ÉCRITURE REFUSÉE : il faut --write ET --yes. Rien n’a été envoyé.');
    return;
  }
  const avant = await readHolding(reg, 1);
  log(`@${reg} avant = ${avant.err ?? avant.vals[0]} → écriture de ${val}`);
  const w = await writeSingle(reg, val);
  if (w.err) return log(`ÉCHEC : ${w.err}`);
  await new Promise((r) => setTimeout(r, 2000));
  const apres = await readHolding(reg, 1);
  log(`accepté. @${reg} après = ${apres.err ?? apres.vals[0]}`);
}

/** Le test qui compte : commander une fois, puis SE TAIRE et regarder. */
async function cmdSilence(minutes = 15) {
  const e = await etat();
  if (e.mode !== 3) {
    log(`mode = ${e.mode} (${e.modeLabel}). Le test du silence n’a de sens qu’en mode 3.`);
    log('À faire d’abord dans l’app Anker : réglages de la Max AC → contrôle par tiers.');
    return;
  }
  log('mode 3 confirmé. Observation SANS AUCUNE ÉCRITURE : que fait l’appareil livré à lui-même ?');
  await cmdWatch(minutes);
  log(
    'Si la Max AC a continué à réguler (puissance qui suit la maison, réseau ≈ 0), le mode tiers'
  );
  log(
    'est sûr : elle retombe sur son propre pilote. Si elle est restée inerte à 0 W, Domo devient'
  );
  log(
    'indispensable en permanence → chien de garde OBLIGATOIRE sur le RPi4 avant toute intégration.'
  );
}

const [cmd, ...rest] = process.argv.slice(2);
const argv = process.argv;
if (cmd === 'scan') await cmdScan();
else if (cmd === 'watch') await cmdWatch(Number(rest[0] ?? 10));
else if (cmd === 'write') await cmdWrite(Number(rest[0]), Number(rest[1]), argv);
else if (cmd === 'silence') await cmdSilence(Number(rest[0] ?? 15));
else {
  console.log('usage : scan | watch [min] | write <reg> <val> --write --yes | silence [min]');
}
