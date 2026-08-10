/**
 * Câblage SHADOW du modèle continu de désirabilité — OBSERVATION SEULE.
 *
 * Appelé à chaque tick à côté du pilote booléen : il calcule D et journalise
 * « aurait chauffé (D=…) », mais NE COMMANDE JAMAIS le relais. C'est le banc de
 * validation en conditions réelles (le recorder est limité/cassé) : on compare,
 * sur plusieurs jours, ce que le modèle aurait fait à ce que le vrai pilote fait,
 * AVANT d'envisager de le passer aux commandes.
 *
 * Adapte CumulusInputs + PilotCtx → DesInputs (modèle sûr : surplus confirmé
 * uniquement, aucune prévision). Rien ici ne persiste ni ne pilote : une
 * exception y est avalée par l'appelant.
 */
import { sunPosition } from './sun.ts';
import {
  computeDesirability,
  defaultDesConfig,
  hysteresisOn,
  type DesInputs
} from './desirability';
import type { CumulusConfig, CumulusInputs, DesirShadowSample } from './types';
import type { PilotCtx } from './pilot';

const cfg = defaultDesConfig();
// Hystérésis shadow (état virtuel, jamais lié au relais réel).
let shadowOn = false;

export interface ShadowResult {
  D: number;
  wouldOn: boolean;
  reason: string;
  logLine: string;
  /** Échantillon structuré pour la persistance (page diagnostic /cumulus-labo). */
  sample: Omit<DesirShadowSample, 'ts'>;
}

export function shadowDesirability(
  inputs: CumulusInputs,
  ctx: PilotCtx,
  config: CumulusConfig
): ShadowResult {
  const socs = inputs.batterySocPct.filter((s) => Number.isFinite(s));
  const socFrac = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length / 100 : 0;
  // Gate d'écrêtage sur le pack le MOINS plein : le parc n'écrête que si AUCUN pack
  // ne peut plus absorber (sinon la Max AC pleine masque un SB3 encore en charge).
  const socFloorFrac = socs.length ? Math.min(...socs) / 100 : 0;

  const di: DesInputs = {
    sunElevDeg: sunPosition(inputs.now, config.pilot.latDeg, config.pilot.lonDeg).elevationDeg,
    pvApsW: Math.max(0, inputs.pvApsW),
    eAvailWh: ctx.eAvailWh,
    eFullWh: ctx.eFullWh,
    gridPowerW: inputs.gridPowerW,
    em50Available: inputs.em50Available,
    maxAcChargeW: inputs.maxAcAvailable ? inputs.maxAcChargeW : null,
    socFrac,
    socFloorFrac,
    heaterW: config.pilot.heatPowerW,
    applianceActive: inputs.appliances.some((a) => a.powerW !== null && a.powerW >= a.onW)
  };

  const res = computeDesirability(di, cfg);
  shadowOn = hysteresisOn(res.D, shadowOn, cfg);
  const s = res.signals;
  const heatingNow = inputs.em50Available && inputs.cumulusPowerW > 500;

  const logLine = `[desir-shadow] D=${res.D.toFixed(2)} aurait=${shadowOn ? 'ON ' : 'off'} | réel=${
    heatingNow ? 'CHAUFFE' : inputs.relayOn ? 'on' : 'off'
  } | room=${s.tankRoom.toFixed(2)} free=${s.freeSurplus.toFixed(2)} (exp${s.freeExport.toFixed(
    1
  )} chg${s.freeCharge.toFixed(1)} curt${s.freeCurtail.toFixed(1)}) win=${s.solarWindow.toFixed(
    2
  )} | soc=${Math.round(socFrac * 100)}%(min${Math.round(socFloorFrac * 100)}%) eAvail=${Math.round(
    ctx.eAvailWh
  )} grid=${Math.round(inputs.gridPowerW)}W | ${res.reason}`;

  const sample: Omit<DesirShadowSample, 'ts'> = {
    d: res.D,
    wouldOn: shadowOn,
    heatingNow,
    relayOn: inputs.relayOn === true,
    tankRoom: s.tankRoom,
    freeExport: s.freeExport,
    freeCharge: s.freeCharge,
    freeCurtail: s.freeCurtail,
    freeSurplus: s.freeSurplus,
    solarWindow: s.solarWindow,
    socPct: Math.round(socFrac * 100),
    socMinPct: Math.round(socFloorFrac * 100),
    eAvailWh: Math.round(ctx.eAvailWh),
    gridPowerW: Math.round(inputs.gridPowerW),
    reason: res.reason
  };

  return { D: res.D, wouldOn: shadowOn, reason: res.reason, logLine, sample };
}
