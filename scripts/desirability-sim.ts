/**
 * Simulation CLOSED-LOOP COMPLÈTE (ballon ET batterie) du modèle continu.
 *
 * Réponse aux DEUX revues adversariales : la v1 ne simulait PAS la batterie (elle
 * lisait le SoC réel) → « zéro-import » était un artefact. La 2e revue (24/07) a
 * montré que (a) sans modéliser le ZÉRO-EXPORT, la sim fabriquait de l'export/charge
 * que la Max AC supprime en réel, et (b) la métrique « coût = diff de minima » était
 * MORTE (dominée par le creux pré-aube partagé + clamp → 0 partout). Corrigé ici :
 *   avail = production − conso_maison − chauffe_modèle
 *   avail>0 → charge bornée par la PLACE restante ; l'excédent est ÉCRÊTÉ au panneau
 *            (PV perdu, compteur ≤70 W), PAS exporté → à batterie pleine maxAcChargeW
 *            et grid → ~0, comme en réel : seul freeCurtail (APS) peut chauffer.
 *   avail<0 → décharge batterie (≤ maxDischarge, ≤ énergie dispo), le reste = IMPORT.
 * Le modèle observe le grid AVEC sa chauffe courante (feedback réel du veto import)
 * et le SoC SIMULÉ. Réserve mesurée HONNÊTEMENT : SoC du SOIR (20h) base sans chauffe
 * vs modèle + drain batterie attribuable au ballon. Conso maison = profil mesuré ;
 * pvApsW = aps_w réel (jamais bridé). Tirages/pertes = modèle calorimétrique du
 * recorder. Le modèle sûr n'utilise AUCUNE prévision (pas de foresight à tricher).
 *
 * Lancer : node --experimental-strip-types scripts/desirability-sim.ts
 */
import Database from 'better-sqlite3';
import { sunPosition } from '../src/lib/server/cumulus/sun.ts';
import {
  computeDesirability,
  defaultDesConfig,
  hysteresisOn,
  type DesInputs
} from '../src/lib/server/cumulus/desirability.ts';

const LAT = 44.4792;
const LON = -1.0835;
const EFULL = 15312;
const ETA = 0.98;
const HEATER = 2900;
const MAX_CHARGE = 2000; // W (parc ~1,6-1,9 kW mesuré, marge)
const MAX_DISCHARGE = 3500; // W (Max AC 3,5 kW)
const ZERO_EXPORT_W = 70; // la Max AC régule l'injection à ~0-70 W ; le reste est ÉCRÊTÉ, pas exporté
const cfg = defaultDesConfig();
const db = new Database('/home/laurent/domo-recorder/history.db', { readonly: true });

// Profil conso maison MESURÉ (W par heure locale — étude).
const HOUSE_BASE = [
  326, 300, 260, 230, 200, 190, 200, 240, 280, 320, 400, 520, 600, 620, 630, 600, 610, 630, 650,
  680, 660, 600, 500, 400
];
const localHour = (ts: number): number => (new Date(ts * 1000).getUTCHours() + 2) % 24;

interface PV {
  ts: number;
  production_w: number | null;
  aps_w: number | null;
  soc_avg: number | null;
}
interface ES {
  ts: number;
  e_avail_wh: number | null;
  draw_wh_day: number | null;
  probe_c: number | null;
  room_c: number | null;
}

const esAll = db
  .prepare(`SELECT ts, e_avail_wh, draw_wh_day, probe_c, room_c FROM energy_samples ORDER BY ts`)
  .all() as ES[];
function esNear(ts: number): ES {
  let lo = 0,
    hi = esAll.length - 1,
    best = esAll[0];
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (esAll[m].ts <= ts) {
      best = esAll[m];
      lo = m + 1;
    } else hi = m - 1;
  }
  return best;
}
function drawW(ts: number): number {
  let i = 0;
  while (i < esAll.length && esAll[i].ts < ts) i++;
  if (i < 2 || i >= esAll.length) return 0;
  const a = esAll[i - 1],
    b = esAll[i];
  const dt = (b.ts - a.ts) / 3600;
  if (dt <= 0) return 0;
  const dd = (b.draw_wh_day ?? 0) - (a.draw_wh_day ?? 0);
  return dd > 0 ? dd / dt : 0;
}

const days: string[] = (
  db
    .prepare(
      `SELECT DISTINCT date(ts,'unixepoch','localtime') d FROM pv_samples
       WHERE ts > strftime('%s','now')-6*86400 ORDER BY d`
    )
    .all() as { d: string }[]
).map((r) => r.d);

console.log('CLOSED-LOOP COMPLET (ballon + BATTERIE simulés, zéro-export modélisé)');
console.log(
  'jour       | solaire | IMPORT | douches min | drain→batt | réserve soir 20h base→modèle'
);
console.log('─'.repeat(84));

for (const day of days) {
  const rows = db
    .prepare(
      `SELECT ts, production_w, aps_w, soc_avg FROM pv_samples
       WHERE date(ts,'unixepoch','localtime')=? ORDER BY ts`
    )
    .all(day) as PV[];
  if (rows.length < 500) continue;
  const capKwh = day >= '2026-07-21' ? 12.6 : 5.376;

  let eAvail = esNear(rows[0].ts).e_avail_wh ?? 11000;
  let socKwh = ((rows[0].soc_avg ?? 50) / 100) * capKwh; // init = SoC réel du matin
  let socBase = socKwh; // trajectoire PARALLÈLE sans AUCUNE chauffe (ligne de base)
  let prevOn = false;
  let solarWh = 0,
    importWh = 0,
    heaterBattDrain = 0;
  let showersMin = 99,
    eveSocModel = -1,
    eveSocBase = -1;

  for (let i = 0; i < rows.length; i += 4) {
    const r = rows[i];
    const dtH = i > 0 ? (r.ts - rows[i - 4].ts) / 3600 : 120 / 3600;
    const es = esNear(r.ts);
    const loss = Math.min(
      120,
      Math.max(30, 2.1 * Math.max(0, (es.probe_c ?? 48) - (es.room_c ?? 25)))
    );
    const draw = drawW(r.ts);
    const hour = localHour(r.ts);
    const prod = r.production_w ?? 0;
    const houseBase = HOUSE_BASE[hour];

    // Grid + charge OBSERVÉS par le modèle avec sa chauffe COURANTE (feedback veto).
    // ZÉRO-EXPORT modélisé : batterie pleine → charge bornée par la PLACE restante,
    // l'excédent est ÉCRÊTÉ au panneau (PV perdu, compteur ~0), PAS exporté. Ainsi
    // maxAcChargeW → 0 et gridPowerW → ~0 à batterie pleine, comme en réel : seul
    // freeCurtail (via l'APS mesuré) peut alors porter la chauffe — la vraie physique.
    const availCur = prod - houseBase - (prevOn ? HEATER : 0);
    const roomW = ((capKwh - socKwh) / Math.max(dtH, 1e-6)) * 1000; // place restante
    const socAvailW = (socKwh / Math.max(dtH, 1e-6)) * 1000;
    let gridCur: number, chargeCur: number;
    if (availCur >= 0) {
      chargeCur = Math.min(availCur, MAX_CHARGE, Math.max(0, roomW));
      const excess = availCur - chargeCur; // ne rentre pas dans la batterie
      gridCur = -Math.min(excess, ZERO_EXPORT_W); // ≤70 W au compteur, le reste écrêté
    } else {
      const dis = Math.min(-availCur, MAX_DISCHARGE, socAvailW);
      chargeCur = 0;
      gridCur = -availCur - dis; // reste = import (grid positif)
    }

    const di: DesInputs = {
      sunElevDeg: sunPosition(r.ts * 1000, LAT, LON).elevationDeg,
      pvApsW: Math.max(0, r.aps_w ?? 0),
      eAvailWh: eAvail,
      eFullWh: EFULL,
      gridPowerW: Math.round(gridCur),
      em50Available: true,
      maxAcChargeW: chargeCur,
      socFrac: socKwh / capKwh,
      heaterW: HEATER,
      applianceActive: false
    };
    const res = computeDesirability(di, cfg);
    let on = hysteresisOn(res.D, prevOn, cfg);

    // Backstop HC nuit (00:06-07:00) si le ballon passe sous la réserve confort.
    let source: 'solar' | 'hc' | null = on ? 'solar' : null;
    const inHC =
      (hour === 0 && new Date(r.ts * 1000).getUTCMinutes() >= 6) || (hour >= 1 && hour < 7);
    if (!on && inHC && eAvail < 4000) {
      on = true;
      source = 'hc';
    }
    prevOn = source === 'solar' ? on : false;

    // Application énergie (zéro-export : charge bornée par la place restante).
    const availNew = prod - houseBase - (on ? HEATER : 0);
    let battOutModel = 0; // sortie batterie (kWh) ce pas, décision modèle
    if (availNew >= 0) {
      const roomNow = ((capKwh - socKwh) / Math.max(dtH, 1e-6)) * 1000;
      socKwh = Math.min(
        capKwh,
        socKwh + (Math.min(availNew, MAX_CHARGE, Math.max(0, roomNow)) * dtH) / 1000
      );
    } else {
      const dis = Math.min(-availNew, MAX_DISCHARGE, (socKwh / Math.max(dtH, 1e-6)) * 1000);
      socKwh = Math.max(0, socKwh - (dis * dtH) / 1000);
      battOutModel = (dis * dtH) / 1000;
      const imp = -availNew - dis; // W importés (batterie insuffisante)
      if (source === 'solar') importWh += (imp * dtH) / 1000;
      // (le HC importe volontairement, tarif plancher — compté à part, non pénalisé)
    }
    if (source === 'solar') solarWh += (HEATER * dtH) / 1000;

    // Ligne de base : même journée SANS aucune chauffe, MÊME physique zéro-export.
    const availBase = prod - houseBase;
    let battOutBase = 0;
    if (availBase >= 0) {
      const roomB = ((capKwh - socBase) / Math.max(dtH, 1e-6)) * 1000;
      socBase = Math.min(
        capKwh,
        socBase + (Math.min(availBase, MAX_CHARGE, Math.max(0, roomB)) * dtH) / 1000
      );
    } else {
      const disB = Math.min(-availBase, MAX_DISCHARGE, (socBase / Math.max(dtH, 1e-6)) * 1000);
      socBase = Math.max(0, socBase - (disB * dtH) / 1000);
      battOutBase = (disB * dtH) / 1000;
    }
    // Drain batterie ATTRIBUABLE au ballon = sortie batterie EN PLUS vs base sans chauffe.
    if (source === 'solar') heaterBattDrain += Math.max(0, battOutModel - battOutBase);

    eAvail = Math.max(
      0,
      Math.min(EFULL, eAvail + (on ? HEATER * dtH * ETA : 0) - loss * dtH - draw * dtH)
    );
    if (hour >= 6) showersMin = Math.min(showersMin, eAvail / 2000);
    // SoC à ~20h : la VRAIE réserve du soir (le minimum journalier était pré-aube).
    if (hour >= 20 && eveSocModel < 0) {
      eveSocModel = socKwh;
      eveSocBase = socBase;
    }
  }

  // Impact NET du ballon sur la réserve du SOIR (20h) = base sans chauffe − modèle.
  // Métrique honnête (revue 24/07 : la diff de minima journaliers était morte à 0,
  // dominée par le creux pré-aube partagé + clamp).
  const eveB = eveSocBase < 0 ? socBase : eveSocBase;
  const eveM = eveSocModel < 0 ? socKwh : eveSocModel;
  const eveCost = eveB - eveM; // kWh de réserve du soir en moins à cause du ballon
  const flagImp = importWh > 0.05 ? ' ⛔' : '';
  const flagRes = eveCost > 0.6 ? ' ⚠️' : ''; // > 0,6 kWh ponctionné le soir = alerte réserve
  console.log(
    `${day} | ${solarWh.toFixed(1).padStart(5)} kWh | ${importWh
      .toFixed(2)
      .padStart(5)}${flagImp} | ${showersMin.toFixed(1).padStart(6)} | ${heaterBattDrain
      .toFixed(2)
      .padStart(5)} | base ${eveB.toFixed(1).padStart(4)} → modèle ${eveM
      .toFixed(1)
      .padStart(4)} kWh (coût ${eveCost.toFixed(2)})${flagRes}`
  );
}
console.log('─'.repeat(84));
console.log(
  '⛔ = import solaire > 0 | drain→batt = kWh batterie sortis EN PLUS à cause du ballon | ' +
    'coût = réserve du SOIR (20h) en moins vs journée sans chauffe (⚠️ si > 0,6 kWh)'
);
db.close();
