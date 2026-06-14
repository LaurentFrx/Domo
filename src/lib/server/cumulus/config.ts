/**
 * Configuration de l'orchestrateur cumulus — persistée dans la section `cumulus`
 * de `data/settings.json` (réutilise settings-store.ts : merge + écriture atomique).
 *
 * Les défauts encodent le profil « Solaire d'abord » (autoconsommation maximale,
 * confort mini garanti). Tout est éditable via /reglages (PUT /api/settings).
 */

import { readSettings, writeSettings } from '../settings-store';
import type { CumulusConfig, EnergyModelConfig } from './types';

const PROFILES = ['solar_first', 'balanced', 'comfort_first'] as const;
type Profile = (typeof PROFILES)[number];

/** Défauts — profil « Solaire d'abord ». */
export function defaultCumulusConfig(): CumulusConfig {
  return {
    profile: 'solar_first',

    tminConfortC: 45,
    tmaxSondeC: 70, // sécurité anti-emballement, AU-DESSUS de la consigne molette (~62-65) → n'interfère pas
    comfortHysteresisC: 4,
    rechargeHysteresisC: 5, // l'eau doit baisser de 5°C sous la dernière charge complète pour relancer
    tempOffsetC: 0,

    surplusOnW: 1800,
    surplusOffW: 0,
    surplusOffGraceSec: 90,

    minOnSec: 300,
    minOffSec: 300,
    antiCyclingSec: 600,

    forecastFaibleKwh: 7,

    autoOffDelaySec: 600,
    tempStaleSec: 1800,

    tankFullPowerW: 250,
    tankFullConfirmSec: 120,
    faultConfirmSec: 300,

    observationMode: true, // ÉTAPE 1a : démarre en observation — zéro chauffe automatique
    batteryMaxDischargeW: 2400, // réservé (réflexe de délestage à venir) — non utilisé pour l'instant

    energyModel: defaultEnergyModel()
  };
}

/** Défauts du modèle d'énergie ballon — valeurs « été » de départ, toutes à calibrer. */
export function defaultEnergyModel(): EnergyModelConfig {
  return {
    etaHeat: 0.98,
    tankWhPerC: 348,
    setpointC: 59,
    inletSummerC: 15,
    inletWinterC: 9,
    outdoorWinterC: 5,
    outdoorSummerC: 25,
    outdoorFallbackC: 18,
    roomOffsetSummerC: 1,
    roomOffsetWinterC: -2,
    roomFallbackC: 20,
    lossCoeffWhPerCh: 1.7,
    eDoucheWhSummer: 2000,
    eDoucheWhWinter: 2800,
    drawDropThresholdC: 1.5,
    probeFullRestC: 55,
    indoorTopic: 'zigbee2mqtt/Thermo SdB'
  };
}

const asProfile = (v: unknown, d: Profile): Profile =>
  typeof v === 'string' && (PROFILES as readonly string[]).includes(v) ? (v as Profile) : d;

/** Nombre fini borné [min, max], sinon défaut. */
const asNum = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};

/** Normalise une config (partielle/brute) en complétant par les défauts + bornes saines. */
export function normalizeCumulusConfig(raw: unknown): CumulusConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultCumulusConfig();
  return {
    profile: asProfile(o.profile, d.profile),

    tminConfortC: asNum(o.tminConfortC, d.tminConfortC, 30, 60),
    tmaxSondeC: asNum(o.tmaxSondeC, d.tmaxSondeC, 50, 80),
    comfortHysteresisC: asNum(o.comfortHysteresisC, d.comfortHysteresisC, 0, 15),
    rechargeHysteresisC: asNum(o.rechargeHysteresisC, d.rechargeHysteresisC, 0, 20),
    tempOffsetC: asNum(o.tempOffsetC, d.tempOffsetC, -20, 20),

    surplusOnW: asNum(o.surplusOnW, d.surplusOnW, 200, 4000),
    surplusOffW: asNum(o.surplusOffW, d.surplusOffW, -2000, 2000),
    surplusOffGraceSec: asNum(o.surplusOffGraceSec, d.surplusOffGraceSec, 0, 600),

    minOnSec: asNum(o.minOnSec, d.minOnSec, 0, 3600),
    minOffSec: asNum(o.minOffSec, d.minOffSec, 0, 3600),
    antiCyclingSec: asNum(o.antiCyclingSec, d.antiCyclingSec, 0, 7200),

    forecastFaibleKwh: asNum(o.forecastFaibleKwh, d.forecastFaibleKwh, 0, 100),

    autoOffDelaySec: asNum(o.autoOffDelaySec, d.autoOffDelaySec, 120, 3600),
    tempStaleSec: asNum(o.tempStaleSec, d.tempStaleSec, 120, 21600),

    tankFullPowerW: asNum(o.tankFullPowerW, d.tankFullPowerW, 50, 1000),
    tankFullConfirmSec: asNum(o.tankFullConfirmSec, d.tankFullConfirmSec, 30, 1800),
    faultConfirmSec: asNum(o.faultConfirmSec, d.faultConfirmSec, 60, 3600),

    observationMode: typeof o.observationMode === 'boolean' ? o.observationMode : d.observationMode,
    batteryMaxDischargeW: asNum(o.batteryMaxDischargeW, d.batteryMaxDischargeW, 500, 10000),

    energyModel: normalizeEnergyModel(o.energyModel)
  };
}

/** Normalise la sous-config energyModel (complète par les défauts + bornes saines). */
export function normalizeEnergyModel(raw: unknown): EnergyModelConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultEnergyModel();
  return {
    etaHeat: asNum(o.etaHeat, d.etaHeat, 0.5, 1),
    tankWhPerC: asNum(o.tankWhPerC, d.tankWhPerC, 50, 2000),
    setpointC: asNum(o.setpointC, d.setpointC, 40, 75),
    inletSummerC: asNum(o.inletSummerC, d.inletSummerC, 5, 30),
    inletWinterC: asNum(o.inletWinterC, d.inletWinterC, 1, 25),
    outdoorWinterC: asNum(o.outdoorWinterC, d.outdoorWinterC, -20, 20),
    outdoorSummerC: asNum(o.outdoorSummerC, d.outdoorSummerC, 10, 45),
    outdoorFallbackC: asNum(o.outdoorFallbackC, d.outdoorFallbackC, -20, 45),
    roomOffsetSummerC: asNum(o.roomOffsetSummerC, d.roomOffsetSummerC, -10, 10),
    roomOffsetWinterC: asNum(o.roomOffsetWinterC, d.roomOffsetWinterC, -10, 10),
    roomFallbackC: asNum(o.roomFallbackC, d.roomFallbackC, 0, 35),
    lossCoeffWhPerCh: asNum(o.lossCoeffWhPerCh, d.lossCoeffWhPerCh, 0.1, 20),
    eDoucheWhSummer: asNum(o.eDoucheWhSummer, d.eDoucheWhSummer, 200, 8000),
    eDoucheWhWinter: asNum(o.eDoucheWhWinter, d.eDoucheWhWinter, 200, 8000),
    drawDropThresholdC: asNum(o.drawDropThresholdC, d.drawDropThresholdC, 0.2, 10),
    probeFullRestC: asNum(o.probeFullRestC, d.probeFullRestC, 40, 70),
    indoorTopic: typeof o.indoorTopic === 'string' && o.indoorTopic ? o.indoorTopic : d.indoorTopic
  };
}

/** Lit la config cumulus (défauts si absente). */
export async function readCumulusConfig(): Promise<CumulusConfig> {
  const s = await readSettings();
  return normalizeCumulusConfig((s as Record<string, unknown>).cumulus);
}

/** Met à jour la config cumulus (merge partiel + normalisation), renvoie la version effective. */
export async function writeCumulusConfig(partial: Partial<CumulusConfig>): Promise<CumulusConfig> {
  const current = await readCumulusConfig();
  const merged = normalizeCumulusConfig({ ...current, ...partial });
  await writeSettings({ cumulus: merged });
  return merged;
}
