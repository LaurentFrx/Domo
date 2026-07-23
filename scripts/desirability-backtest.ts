/**
 * Backtest du modèle continu de désirabilité (desirability.ts) sur history.db.
 * Rejoue les inputs reconstruits du recorder, applique le modèle + hystérésis, et
 * compare « aurait chauffé » à la réalité (em50_cumulus_w) + vérifie la
 * plausibilité zéro-import (surplus présent quand le modèle chauffe).
 *
 * Reconstruction (honnête, avec ses limites) :
 *  - eAvailWh ← energy_samples.e_avail_wh (le vrai modèle calorimétrique) ;
 *  - surplus absorbé ← max(0, d(batt_energy_wh)/dt) = charge réelle du parc
 *    (les champs charge cloud sont cassés ; la dérivée d'énergie est fiable) ;
 *  - dSoc/dt ← dérivée de soc_avg ; export ← em50_grid_w signé ;
 *  - forecastRemaining ← intégrale de la prod RÉELLE restante du jour
 *    (foresight parfait — le live utilisera AROME, moins parfait : à noter) ;
 *  - appliances non reconstructibles → false (limite assumée).
 *
 * Lancer : node --experimental-strip-types scripts/desirability-backtest.ts
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
const DB = '/home/laurent/domo-recorder/history.db';
const cfg = defaultDesConfig();

const db = new Database(DB, { readonly: true });

interface Row {
  ts: number;
  em50_grid_w: number | null;
  em50_cumulus_w: number | null;
  soc_avg: number | null;
  batt_energy_wh: number | null;
  production_w: number | null;
  aps_w: number | null;
}

const days: string[] = db
  .prepare(
    `SELECT DISTINCT date(ts,'unixepoch','localtime') d FROM pv_samples
     WHERE ts > strftime('%s','now')-13*86400 ORDER BY d`
  )
  .all()
  .map((r: { d: string }) => r.d);

// energy_samples indexé pour lookup rapide du eAvail le plus proche.
const eRows = db
  .prepare(`SELECT ts, e_avail_wh, probe_c, room_c FROM energy_samples ORDER BY ts`)
  .all() as {
  ts: number;
  e_avail_wh: number | null;
  probe_c: number | null;
  room_c: number | null;
}[];
function nearestEAvail(ts: number): { eAvail: number; loss: number } {
  let lo = 0,
    hi = eRows.length - 1,
    best = eRows[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (eRows[mid].ts <= ts) {
      best = eRows[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const eAvail = best?.e_avail_wh ?? 10000;
  // pertes ≈ lossCoeff 2.1 × ΔT(probe−room), borné (mesuré ~55-90 Wh/h)
  const dT = Math.max(0, (best?.probe_c ?? 48) - (best?.room_c ?? 25));
  return { eAvail, loss: Math.min(120, Math.max(30, 2.1 * dT)) };
}

function minutesToNext0700(ts: number): number {
  const d = new Date(ts * 1000);
  // heure locale Paris (le VPS est UTC ; +2 l'été CEST — approx suffisante ici)
  const localMin = ((d.getUTCHours() + 2) % 24) * 60 + d.getUTCMinutes();
  const target = 7 * 60;
  return localMin < target ? target - localMin : 24 * 60 - localMin + target;
}

console.log('jour        | réel  | modèle continu       | contrôle zéro-import');
console.log('            | chauf | heures  kWh  fenêtre | %surplus  socMin');
console.log('─'.repeat(74));

let totFixed = 0;
for (const day of days) {
  const rows = db
    .prepare(
      `SELECT ts, em50_grid_w, em50_cumulus_w, soc_avg, batt_energy_wh, production_w, aps_w
       FROM pv_samples WHERE date(ts,'unixepoch','localtime')=? ORDER BY ts`
    )
    .all(day) as Row[];
  if (rows.length < 100) continue;

  const post = day >= '2026-07-21'; // Max AC dans le parc
  const capKwh = post ? 12.6 : 5.376;

  // prod restante du jour (foresight) : suffixe intégral.
  const remKwh: number[] = new Array(rows.length).fill(0);
  for (let i = rows.length - 2; i >= 0; i--) {
    const dt = (rows[i + 1].ts - rows[i].ts) / 3600;
    remKwh[i] = remKwh[i + 1] + ((rows[i + 1].production_w ?? 0) * dt) / 1000;
  }

  let prevOn = false;
  let onSamples = 0;
  let onWithSurplus = 0;
  let socMinOn = 100;
  let firstOn = '',
    lastOn = '';
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i];
    const dtH = (r.ts - rows[i - 3].ts) / 3600;
    const battChargeW =
      dtH > 0
        ? Math.max(0, ((r.batt_energy_wh ?? 0) - (rows[i - 3].batt_energy_wh ?? 0)) / dtH)
        : 0;
    const socFrac = (r.soc_avg ?? 0) / 100;
    const dSoc = dtH > 0 ? ((r.soc_avg ?? 0) - (rows[i - 3].soc_avg ?? 0)) / 100 / dtH : 0;
    const { eAvail, loss } = nearestEAvail(r.ts);
    const elev = sunPosition(r.ts * 1000, LAT, LON).elevationDeg;

    const di: DesInputs = {
      sunElevDeg: elev,
      eAvailWh: eAvail,
      eFullWh: 15312,
      comfortReserveWh: 4000,
      hardComfortWh: 2000,
      lossPerHWh: loss,
      minutesToDeadline: minutesToNext0700(r.ts),
      gridPowerW: r.em50_grid_w ?? 0,
      maxAcChargeW: battChargeW, // proxy fiable : charge réelle du parc
      socFrac,
      dSocFracPerH: dSoc,
      forecastRemainingKwh: remKwh[i],
      eveningReserveKwh: 5,
      batteryCapacityKwh: capKwh,
      heaterW: 2900,
      applianceActive: false
    };
    const res = computeDesirability(di, cfg);
    const on = hysteresisOn(res.D, prevOn, cfg);
    prevOn = on;
    if (on) {
      onSamples++;
      const hhmm = new Date((r.ts + 7200) * 1000).toISOString().slice(11, 16);
      if (!firstOn) firstOn = hhmm;
      lastOn = hhmm;
      socMinOn = Math.min(socMinOn, r.soc_avg ?? 100);
      // surplus présent ? export franc OU parc en charge OU parc quasi plein
      const surplus = Math.max(0, -(r.em50_grid_w ?? 0)) > 50 || battChargeW > 150 || socFrac > 0.9;
      if (surplus) onWithSurplus++;
    }
  }

  const dt = rows.length > 1 ? (rows[1].ts - rows[0].ts) / 3600 : 30 / 3600;
  const modelHeatH = onSamples * dt;
  const modelKwh = modelHeatH * 2.9;
  const realKwh =
    (rows.reduce((s, r) => s + ((r.em50_cumulus_w ?? 0) > 500 ? (r.em50_cumulus_w ?? 0) : 0), 0) *
      dt) /
    1000;
  const pctSurplus = onSamples ? Math.round((100 * onWithSurplus) / onSamples) : 0;
  const fixed = realKwh < 0.1 && modelKwh > 0.5;
  if (fixed) totFixed++;
  console.log(
    `${day} | ${realKwh.toFixed(1).padStart(4)} | ${modelHeatH.toFixed(1).padStart(4)}h ${modelKwh
      .toFixed(1)
      .padStart(4)} ${(firstOn && lastOn ? `${firstOn}-${lastOn}` : '—').padStart(12)} | ${String(
      pctSurplus
    ).padStart(4)}%     ${socMinOn === 100 ? '—' : Math.round(socMinOn) + '%'}${
      fixed ? '   ✅ débloqué' : ''
    }`
  );
}
console.log('─'.repeat(74));
console.log(`Jours zéro-chauffe débloqués par le modèle : ${totFixed}`);

// ─── DEBUG : dump des signaux du 23/07 (jour deadlock) toutes les 30 min ───
if (process.argv.includes('--debug')) {
  const day = '2026-07-23';
  const rows = db
    .prepare(
      `SELECT ts, em50_grid_w, em50_cumulus_w, soc_avg, batt_energy_wh, production_w, aps_w
       FROM pv_samples WHERE date(ts,'unixepoch','localtime')=? ORDER BY ts`
    )
    .all(day) as Row[];
  const remKwh: number[] = new Array(rows.length).fill(0);
  for (let i = rows.length - 2; i >= 0; i--) {
    const dt = (rows[i + 1].ts - rows[i].ts) / 3600;
    remKwh[i] = remKwh[i + 1] + ((rows[i + 1].production_w ?? 0) * dt) / 1000;
  }
  console.log(
    '\n═══ DEBUG 23/07 ═══ heure elev eAvail soc chgW exp | room comfU free resH win | D'
  );
  for (let i = 3; i < rows.length; i += 60) {
    const r = rows[i];
    const dtH = (r.ts - rows[i - 3].ts) / 3600;
    const battChargeW =
      dtH > 0
        ? Math.max(0, ((r.batt_energy_wh ?? 0) - (rows[i - 3].batt_energy_wh ?? 0)) / dtH)
        : 0;
    const { eAvail, loss } = nearestEAvail(r.ts);
    const di: DesInputs = {
      sunElevDeg: sunPosition(r.ts * 1000, LAT, LON).elevationDeg,
      eAvailWh: eAvail,
      eFullWh: 15312,
      comfortReserveWh: 4000,
      hardComfortWh: 2000,
      lossPerHWh: loss,
      minutesToDeadline: minutesToNext0700(r.ts),
      gridPowerW: r.em50_grid_w ?? 0,
      maxAcChargeW: battChargeW,
      socFrac: (r.soc_avg ?? 0) / 100,
      dSocFracPerH: dtH > 0 ? ((r.soc_avg ?? 0) - (rows[i - 3].soc_avg ?? 0)) / 100 / dtH : 0,
      forecastRemainingKwh: remKwh[i],
      eveningReserveKwh: 5,
      batteryCapacityKwh: 12.6,
      heaterW: 2900,
      applianceActive: false
    };
    const res = computeDesirability(di, cfg);
    const s = res.signals;
    const hhmm = new Date((r.ts + 7200) * 1000).toISOString().slice(11, 16);
    console.log(
      `${hhmm} ${di.sunElevDeg.toFixed(0).padStart(3)}° ${eAvail.toFixed(0).padStart(5)} ${(r.soc_avg ?? 0).toFixed(0).padStart(3)}% ${battChargeW.toFixed(0).padStart(4)} ${Math.max(
        0,
        -(r.em50_grid_w ?? 0)
      )
        .toFixed(0)
        .padStart(
          4
        )} | ${s.tankRoom.toFixed(2)} ${s.comfortUrgency.toFixed(2)} ${s.freeSurplus.toFixed(2)} ${s.reserveHealth.toFixed(2)} ${s.solarWindow.toFixed(2)} | ${res.D.toFixed(2)}`
    );
  }
}

db.close();
