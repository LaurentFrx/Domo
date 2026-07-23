/**
 * Simulation CLOSED-LOOP COMPLÈTE (ballon ET batterie) du modèle continu.
 *
 * Réponse à la revue adversariale (23/07) : la v1 ne simulait PAS la batterie
 * (elle lisait le SoC réel) → « zéro-import » était un artefact. Ici on simule
 * le flux énergétique complet sous les décisions du MODÈLE :
 *   avail = production − conso_maison − chauffe_modèle
 *   avail>0 → charge batterie (≤ maxCharge), l'excédent est écrêté/exporté
 *   avail<0 → décharge batterie (≤ maxDischarge, ≤ énergie dispo), le reste = IMPORT
 * Le modèle observe le grid AVEC sa chauffe courante (feedback réel du veto import)
 * et le SoC SIMULÉ. On mesure alors le VRAI import et la VRAIE trajectoire de
 * réserve. Conso maison = profil mesuré (étude ; champs batterie cloud cassés) ;
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
const RESERVE_KWH = 7; // réserve du soir à surveiller
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

console.log('CLOSED-LOOP COMPLET (ballon + BATTERIE simulés sous le modèle sûr)');
console.log('jour       | solaire | IMPORT | ballon douches min | SoC batt min | SoC soir');
console.log('─'.repeat(80));

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
    importWh = 0;
  let socMin = capKwh,
    socBaseMin = capKwh,
    showersMin = 99;

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
    const availCur = prod - houseBase - (prevOn ? HEATER : 0);
    const socAvailW = (socKwh / Math.max(dtH, 1e-6)) * 1000;
    let gridCur: number, chargeCur: number;
    if (availCur >= 0) {
      chargeCur = Math.min(availCur, MAX_CHARGE);
      gridCur = -(availCur - chargeCur); // excédent exporté/écrêté → grid négatif
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

    // Application énergie avec la décision finale.
    const availNew = prod - houseBase - (on ? HEATER : 0);
    if (availNew >= 0) {
      socKwh = Math.min(capKwh, socKwh + (Math.min(availNew, MAX_CHARGE) * dtH) / 1000);
    } else {
      const dis = Math.min(-availNew, MAX_DISCHARGE, (socKwh / Math.max(dtH, 1e-6)) * 1000);
      socKwh = Math.max(0, socKwh - (dis * dtH) / 1000);
      const imp = -availNew - dis; // W importés (batterie insuffisante)
      if (source === 'solar') importWh += (imp * dtH) / 1000;
      // (le HC importe volontairement, tarif plancher — compté à part, non pénalisé)
    }
    if (source === 'solar') solarWh += (HEATER * dtH) / 1000;

    // Ligne de base : même journée SANS aucune chauffe → montre le drain NATUREL
    // (maison seule). L'écart socMin(modèle) − socMin(base) = ce que le ballon coûte
    // vraiment à la réserve.
    const availBase = prod - houseBase;
    if (availBase >= 0)
      socBase = Math.min(capKwh, socBase + (Math.min(availBase, MAX_CHARGE) * dtH) / 1000);
    else
      socBase = Math.max(
        0,
        socBase -
          (Math.min(-availBase, MAX_DISCHARGE, (socBase / Math.max(dtH, 1e-6)) * 1000) * dtH) / 1000
      );

    eAvail = Math.max(
      0,
      Math.min(EFULL, eAvail + (on ? HEATER * dtH * ETA : 0) - loss * dtH - draw * dtH)
    );
    if (hour >= 6) {
      socMin = Math.min(socMin, socKwh);
      socBaseMin = Math.min(socBaseMin, socBase);
      showersMin = Math.min(showersMin, eAvail / 2000);
    }
  }

  const flagImp = importWh > 0.05 ? ' ⛔' : '';
  const cost = socBaseMin - socMin; // ce que le ballon a coûté à la réserve mini
  const flagRes = cost > 1.0 ? ' ⚠️' : ''; // le MODÈLE aggrave la réserve de > 1 kWh
  console.log(
    `${day} | ${solarWh.toFixed(1).padStart(5)} kWh | ${importWh
      .toFixed(2)
      .padStart(5)}${flagImp} | ${showersMin.toFixed(1).padStart(6)} | base ${socBaseMin
      .toFixed(1)
      .padStart(
        4
      )} → modèle ${socMin.toFixed(1).padStart(4)} kWh (coût ${cost.toFixed(1)})${flagRes}`
  );
}
console.log('─'.repeat(80));
console.log(
  '⛔ = import solaire > 0 | coût = SoC mini SANS chauffe − AVEC modèle (impact réel du ballon sur la réserve)'
);
db.close();
