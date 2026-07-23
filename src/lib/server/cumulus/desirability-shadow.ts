/**
 * Câblage SHADOW du modèle continu de désirabilité — OBSERVATION SEULE.
 *
 * Appelé à chaque tick à côté du pilote booléen : il calcule D et journalise
 * « aurait chauffé (D=…) », mais NE COMMANDE JAMAIS le relais. C'est le banc de
 * validation en conditions réelles (le recorder est limité/cassé) : on compare,
 * sur plusieurs jours, ce que le modèle aurait fait à ce que le vrai pilote fait,
 * AVANT d'envisager de le passer aux commandes.
 *
 * Adapte CumulusInputs + PilotCtx → DesInputs. La dérivée du SoC est suivie en
 * mémoire de process (ticks à 60 s) ; sur redémarrage elle repart à 0 (conservateur).
 * Rien ici ne persiste ni ne pilote : une exception y est avalée par l'appelant.
 */
import { sunPosition } from './sun.ts';
import {
  computeDesirability,
  defaultDesConfig,
  hysteresisOn,
  type DesInputs
} from './desirability';
import type { CumulusConfig, CumulusInputs } from './types';
import type { PilotCtx } from './pilot';

const cfg = defaultDesConfig();
/** Réserve batterie du soir à protéger (kWh) : la maison draine ~4-5 kWh/nuit. */
const EVENING_RESERVE_KWH = 7;

// Suivi de la dérivée du SoC entre ticks (mémoire de process, ~60 s).
let prevSoc: { ts: number; frac: number } | null = null;
// Hystérésis shadow (état virtuel, jamais lié au relais réel).
let shadowOn = false;

export interface ShadowResult {
  D: number;
  wouldOn: boolean;
  reason: string;
  logLine: string;
}

export function shadowDesirability(
  inputs: CumulusInputs,
  ctx: PilotCtx,
  config: CumulusConfig
): ShadowResult {
  const socs = inputs.batterySocPct.filter((s) => Number.isFinite(s));
  const socFrac = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length / 100 : 0;

  let dSocFracPerH = 0;
  if (prevSoc && inputs.now > prevSoc.ts) {
    dSocFracPerH = (socFrac - prevSoc.frac) / ((inputs.now - prevSoc.ts) / 3_600_000);
  }
  prevSoc = { ts: inputs.now, frac: socFrac };

  const minuteOfDay = ctx.minuteOfDay;
  const minutesToDeadline = minuteOfDay < 420 ? 420 - minuteOfDay : 1860 - minuteOfDay;

  const di: DesInputs = {
    sunElevDeg: sunPosition(inputs.now, config.pilot.latDeg, config.pilot.lonDeg).elevationDeg,
    eAvailWh: ctx.eAvailWh,
    eFullWh: ctx.eFullWh,
    comfortReserveWh: config.pilot.reserveShowers * ctx.eDoucheWh,
    hardComfortWh: ctx.eDoucheWh,
    lossPerHWh: ctx.lossPerHWh,
    minutesToDeadline,
    gridPowerW: inputs.gridPowerW,
    maxAcChargeW: inputs.maxAcAvailable ? inputs.maxAcChargeW : null,
    socFrac,
    dSocFracPerH,
    forecastRemainingKwh: inputs.forecastAvailable ? Math.max(0, inputs.solNextDaylightKwh) : 0,
    eveningReserveKwh: EVENING_RESERVE_KWH,
    batteryCapacityKwh: inputs.batteryCapacityWh > 0 ? inputs.batteryCapacityWh / 1000 : 12.6,
    heaterW: config.pilot.heatPowerW,
    applianceActive: inputs.appliances.some((a) => a.powerW !== null && a.powerW >= a.onW)
  };

  const res = computeDesirability(di, cfg);
  shadowOn = hysteresisOn(res.D, shadowOn, cfg);
  const s = res.signals;
  const heatingNow = inputs.em50Available && inputs.cumulusPowerW > 500;

  const logLine = `[desir-shadow] D=${res.D.toFixed(2)} aurait=${shadowOn ? 'ON ' : 'off'} | réel=${
    heatingNow ? 'CHAUFFE' : inputs.relayOn ? 'on' : 'off'
  } | room=${s.tankRoom.toFixed(2)} free=${s.freeSurplus.toFixed(2)} resv=${s.reserveHealth.toFixed(
    2
  )} plan=${s.solarConfidence.toFixed(2)} win=${s.solarWindow.toFixed(2)} urg=${s.comfortUrgency.toFixed(
    2
  )} | soc=${Math.round(socFrac * 100)}% eAvail=${Math.round(ctx.eAvailWh)} | ${res.reason}`;

  return { D: res.D, wouldOn: shadowOn, reason: res.reason, logLine };
}
