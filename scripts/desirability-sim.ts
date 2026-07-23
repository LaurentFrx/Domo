/**
 * Simulation CLOSED-LOOP (côté ballon) du modèle continu sur history.db.
 *
 * Corrige le biais open-loop : au lieu de lire le eAvail RÉEL (qui reflète la
 * chauffe du vrai pilote), on SIMULE la trajectoire propre du ballon sous les
 * décisions du MODÈLE (eAvail += chauffe_modèle×η − pertes − tirages). Les
 * tirages et pertes viennent du modèle calorimétrique du recorder (draw_wh_day
 * / loss_wh_day) — cohérents quel que soit le moment de chauffe.
 *
 * Batterie/surplus : NON simulés (champs cloud cassés) → on utilise le SoC RÉEL
 * enregistré + un profil de conso maison MESURÉ (étude) → surplus_dispo =
 * production − house_base. Honnête sur ses limites (cf. rapport). Le contrôle
 * zéro-import = « quand le modèle chauffe, la couverture production−conso
 * couvre-t-elle 2900 W, ou la batterie (SoC réel > plancher) complète-t-elle ? ».
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
const cfg = defaultDesConfig();
const db = new Database('/home/laurent/domo-recorder/history.db', { readonly: true });

// Profil conso maison MESURÉ (W par heure locale — étude 23/07 : talon ~200,
// midi ~600, pointe soir ~660). Robuste, jour-indépendant (les champs batterie
// cassés interdisent une reconstruction par-instant fiable).
const HOUSE_BASE = [
  326, 300, 260, 230, 200, 190, 200, 240, 280, 320, 400, 520, 600, 620, 630, 600, 610, 630, 650,
  680, 660, 600, 500, 400
];
const localHour = (ts: number): number => (new Date(ts * 1000).getUTCHours() + 2) % 24;

interface PV {
  ts: number;
  production_w: number | null;
  em50_cumulus_w: number | null;
  soc_avg: number | null;
  batt_energy_wh: number | null;
}
interface ES {
  ts: number;
  e_avail_wh: number | null;
  draw_wh_day: number | null;
  loss_wh_day: number | null;
  probe_c: number | null;
  room_c: number | null;
}

const esAll = db
  .prepare(
    `SELECT ts, e_avail_wh, draw_wh_day, loss_wh_day, probe_c, room_c FROM energy_samples ORDER BY ts`
  )
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
/** Débit de tirage instantané (W) au ts : pente de draw_wh_day autour de ts. */
function drawW(ts: number): number {
  let i = 0;
  while (i < esAll.length && esAll[i].ts < ts) i++;
  if (i < 2 || i >= esAll.length) return 0;
  const a = esAll[i - 1],
    b = esAll[i];
  const dt = (b.ts - a.ts) / 3600;
  if (dt <= 0) return 0;
  const dd = (b.draw_wh_day ?? 0) - (a.draw_wh_day ?? 0); // reset minuit → négatif ignoré
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

console.log('CLOSED-LOOP (ballon simulé sous le modèle) — parc 12,6 kWh, HC backstop 00h06-07h');
console.log(
  'jour       | solaire modèle | HC  | import | couv.min | douches min | SoC evening réel'
);
console.log('─'.repeat(88));

for (const day of days) {
  const rows = db
    .prepare(
      `SELECT ts, production_w, em50_cumulus_w, soc_avg, batt_energy_wh FROM pv_samples
       WHERE date(ts,'unixepoch','localtime')=? ORDER BY ts`
    )
    .all(day) as PV[];
  if (rows.length < 500) continue;
  const capKwh = day >= '2026-07-21' ? 12.6 : 5.376;

  // prod restante (foresight) pour reserveHealth (info seulement, hors décision tick).
  const rem: number[] = new Array(rows.length).fill(0);
  for (let i = rows.length - 2; i >= 0; i--)
    rem[i] =
      rem[i + 1] + ((rows[i + 1].production_w ?? 0) * (rows[i + 1].ts - rows[i].ts)) / 3600 / 1000;

  let eAvail = esNear(rows[0].ts).e_avail_wh ?? 11000; // init = état réel du matin
  let prevOn = false;
  let solarWh = 0,
    hcWh = 0,
    importWh = 0;
  let covMin = 9999,
    showersMin = 99;

  for (let i = 3; i < rows.length; i += 4) {
    // pas ~2 min
    const r = rows[i];
    const dtH = (r.ts - rows[i - 4]?.ts || 120) / 3600 || 120 / 3600;
    const es = esNear(r.ts);
    const loss = Math.min(
      120,
      Math.max(30, 2.1 * Math.max(0, (es.probe_c ?? 48) - (es.room_c ?? 25)))
    );
    const draw = drawW(r.ts);
    const hour = localHour(r.ts);
    const houseBase = HOUSE_BASE[hour];
    const prod = r.production_w ?? 0;
    const surplusAvail = Math.max(0, prod - houseBase); // dispo pour batterie+ballon
    const socFrac = (r.soc_avg ?? 0) / 100;
    const dSoc =
      dtH > 0 ? ((r.soc_avg ?? 0) - (rows[i - 4]?.soc_avg ?? r.soc_avg ?? 0)) / 100 / dtH : 0;

    const di: DesInputs = {
      sunElevDeg: sunPosition(r.ts * 1000, LAT, LON).elevationDeg,
      eAvailWh: eAvail, // ← SIMULÉ (closed-loop)
      eFullWh: EFULL,
      comfortReserveWh: 4000,
      hardComfortWh: 2000,
      lossPerHWh: loss,
      minutesToDeadline: (() => {
        const m = hour * 60 + new Date(r.ts * 1000).getUTCMinutes();
        return m < 420 ? 420 - m : 1860 - m;
      })(),
      gridPowerW: 0,
      maxAcChargeW: surplusAvail, // surplus AVANT décision (SoC-gated dans le modèle)
      socFrac,
      dSocFracPerH: dSoc,
      forecastRemainingKwh: rem[i],
      eveningReserveKwh: 7,
      batteryCapacityKwh: capKwh,
      heaterW: HEATER,
      applianceActive: false
    };
    const res = computeDesirability(di, cfg);
    let on = hysteresisOn(res.D, prevOn, cfg);

    // Backstop HC : dans la fenêtre creuse, si le ballon passe sous la réserve
    // confort, on chauffe (source réseau bon marché). Séparé du solaire.
    const inHC = hour === 0 ? new Date(r.ts * 1000).getUTCMinutes() >= 6 || true : hour < 7;
    const hcHeat = inHC && eAvail < 4000;
    let source: 'solar' | 'hc' | null = null;
    if (on) source = 'solar';
    else if (hcHeat) {
      on = true;
      source = 'hc';
    }
    prevOn = source === 'solar' ? on : prevOn; // hystérésis suit le solaire

    // Bilan énergie du pas
    const heatWh = on ? HEATER * dtH : 0;
    if (on) {
      if (source === 'solar') {
        const cov = Math.min(HEATER, surplusAvail); // couvert par le solaire direct
        covMin = Math.min(covMin, surplusAvail);
        const fromBatt = HEATER - cov; // le reste vient de la batterie
        // import seulement si la batterie est au plancher (SoC réel ≤ 12 %)
        if (socFrac <= 0.12) importWh += (fromBatt * dtH) / 1000;
        solarWh += (HEATER * dtH) / 1000;
      } else {
        hcWh += (HEATER * dtH) / 1000;
      }
    }
    // Trajectoire ballon
    eAvail = Math.max(0, Math.min(EFULL, eAvail + heatWh * ETA - loss * dtH - draw * dtH));
    const showers = eAvail / 2000;
    if (hour >= 6) showersMin = Math.min(showersMin, showers);
  }

  const socEvening =
    rows.find((r) => localHour(r.ts) === 21)?.soc_avg ?? rows[rows.length - 1].soc_avg ?? 0;
  console.log(
    `${day} | ${solarWh.toFixed(1).padStart(6)} kWh    | ${hcWh.toFixed(1).padStart(3)} | ${importWh
      .toFixed(2)
      .padStart(5)} | ${(covMin === 9999 ? 0 : covMin).toFixed(0).padStart(5)} W | ${showersMin
      .toFixed(1)
      .padStart(6)}      | ${Math.round(socEvening)}%`
  );
}
console.log('─'.repeat(88));
console.log('import > 0 = violation zéro-import | douches min = pire réserve confort du jour');
db.close();
