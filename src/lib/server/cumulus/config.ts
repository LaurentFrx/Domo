/**
 * Configuration de l'orchestrateur cumulus — persistée dans la section `cumulus`
 * de `data/settings.json` (réutilise settings-store.ts : merge + écriture atomique).
 *
 * Les défauts encodent le profil « Solaire d'abord » (autoconsommation maximale,
 * confort mini garanti). Tout est éditable via /reglages (PUT /api/settings).
 */

import { readSettings, writeSettings } from '../settings-store';
import type { CumulusConfig, EnergyModelConfig, OutdoorSourcesConfig, PilotConfig } from './types';

const PROFILES = ['solar_first', 'balanced', 'comfort_first'] as const;
type Profile = (typeof PROFILES)[number];

/** Défauts — profil « Solaire d'abord ». */
export function defaultCumulusConfig(): CumulusConfig {
  return {
    profile: 'solar_first',

    tminConfortC: 45, // « eau au moins tiède » (détection tank_full vs panne) — plus de chauffe de confort
    tmaxSondeC: 70, // sécurité anti-emballement, AU-DESSUS de la consigne molette (~62-65) → n'interfère pas
    rechargeHysteresisC: 5, // l'eau doit baisser de 5°C sous la dernière charge complète pour relancer
    tempOffsetC: 0,

    minOnSec: 300,
    minOffSec: 300,
    antiCyclingSec: 600,

    forecastFaibleKwh: 7,

    autoOffDelaySec: 600,
    tempStaleSec: 1800,

    tankFullPowerW: 250,
    tankFullConfirmSec: 120,
    faultConfirmSec: 300,

    observationMode: true, // V2 : démarre en OBSERVATION — le pilote journalise, ne commande pas
    batteryMaxDischargeW: 2400, // réservé — non utilisé

    energyModel: defaultEnergyModel(),
    pilot: defaultPilotConfig()
  };
}

/** Défauts du PILOTE V2 — valeurs de la spec annotée par Laurent (03/07/2026). */
export function defaultPilotConfig(): PilotConfig {
  return {
    // Allumage solaire
    exportOnW: 200, // don franc au réseau exigé (valeur Laurent)
    observationBeforeOnSec: 180, // conditions tenues 3 min avant d'allumer (valeur Laurent)
    battFullPct: 98, // batteries « pleines » (valeur Laurent)
    chargeIdleW: 120, // charge résiduelle « quasi nulle »
    solarStartsPerDay: 2, // quota d'allumages SPONTANÉS (reprises après cession-achat HORS quota)
    apsMinW: 300, // soleil RÉEL exigé (production APS minimale)
    minUsefulHeatMin: 45, // jamais d'allumage à moins de 45 min de la fin de fenêtre
    invisibleSurplusMinW: 2000, // déclencheur de secours : surplus invisible estimé minimal

    // Grâce et coupures
    graceStartupSec: 240, // latence SolarBank tolérée au démarrage (4 min)
    cutBuyW: 150, // achat réseau déclenchant la coupure
    cutBuySustainSec: 30, // soutenu 30 s (VALEUR CORRIGÉE PAR LAURENT — pas 90)
    cutBuyHardW: 500, // achat franc → coupure immédiate (four/plaques : la cuisine d'abord)
    batteryDropCutPts: 20, // SoC −20 points depuis le début de chauffe → coupure (valeur Laurent)
    batteryFloorCutPct: 40, // plancher absolu de SoC en chauffe (valeur Laurent)

    // Fenêtre solaire par éphémérides (défauts ≈ 10 h 30 – 16 h 30/17 h aux équinoxes,
    // s'étend naturellement l'été — c'est l'élévation qui suit la saison, pas des dates)
    sunElevStartDeg: 20,
    sunAzStartDeg: 120,
    sunElevEndDeg: 30,
    sunAzEndDeg: 252,
    degradedWindowEndH: 15, // cloud Anker muet → fin resserrée à 15 h

    // Recharge HC de fin de nuit
    hcEndTarget: '07:15',
    hcPlanHour: 22,
    hcMorningReservePct: 30, // réserve batterie pour les consos matinales
    hcGrey1Factor: 1.3, // J+1 gris → besoin × 1,3
    hcGrey2Factor: 1.6, // J+1 ET J+2 gris → besoin × 1,6

    // Alerte « APS muet » (l'étalon de toute la détection solaire)
    apsStaleSec: 300, // données APS périmées au-delà (fenêtre ouverte) → « injoignable »
    apsMuteFloorW: 30, // APS ≤ 30 W…
    apsMuteConfirmSec: 600, // … pendant 10 min…
    apsTwinMinW: 200, // … alors que les jumeaux SB1 chargent ≥ 200 W → « panne probable »

    // Divers
    reserveShowers: 2,
    fullFraction: 0.95,
    heatPowerW: 2900, // spec : durée = déficit / (2900 × etaHeat)
    sb1BatteryIndex: 0, // index de la station SUD dans batteries[] (à confirmer en observation)
    latDeg: 44.4792, // Sanguinet — coordonnées du forecast-bridge (FORECAST_LAT/LON)
    lonDeg: -1.0835
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
    lossCoeffWhPerCh: 2.1, // = Cr·V/24 (fiche Atlantic 154330 : Cr=0,17 Wh/L/°C/24h × 300 L = 2,125) ; recoupé par Qpr=2,41 kWh/24h à ΔT≈47°C. La sonde de point bas surlit ~×2 (stratification) → ne PAS calibrer dessus.
    eDoucheWhSummer: 2000,
    eDoucheWhWinter: 2800,
    drawDropThresholdC: 2.0,
    drawWindowMin: 20,
    drawStratFactor: 2.8, // sonde de point bas surlit l'amplitude des puisages ~×2,8 (stratification) ; calibré par calorimétrie EM-50 (replay 14→29/06)
    probeFullRestC: 55,
    indoorTopics: ['zigbee2mqtt/Thermo SdB', 'zigbee2mqtt/Thermo Salon'],
    outdoorSources: {
      daikin: true,
      thermoExtTopic: 'zigbee2mqtt/Thermo_ext',
      forecast: true
    }
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
    rechargeHysteresisC: asNum(o.rechargeHysteresisC, d.rechargeHysteresisC, 0, 20),
    tempOffsetC: asNum(o.tempOffsetC, d.tempOffsetC, -20, 20),

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

    energyModel: normalizeEnergyModel(o.energyModel),
    pilot: normalizePilotConfig(o.pilot)
  };
}

/** Normalise la sous-config pilot (complète par les défauts + bornes saines). */
export function normalizePilotConfig(raw: unknown): PilotConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultPilotConfig();
  const asHm = (v: unknown, dflt: string): string =>
    typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : dflt;
  return {
    exportOnW: asNum(o.exportOnW, d.exportOnW, 50, 2000),
    observationBeforeOnSec: asNum(o.observationBeforeOnSec, d.observationBeforeOnSec, 60, 1800),
    battFullPct: asNum(o.battFullPct, d.battFullPct, 80, 100),
    chargeIdleW: asNum(o.chargeIdleW, d.chargeIdleW, 0, 1000),
    solarStartsPerDay: asNum(o.solarStartsPerDay, d.solarStartsPerDay, 1, 10),
    apsMinW: asNum(o.apsMinW, d.apsMinW, 50, 900),
    minUsefulHeatMin: asNum(o.minUsefulHeatMin, d.minUsefulHeatMin, 10, 240),
    invisibleSurplusMinW: asNum(o.invisibleSurplusMinW, d.invisibleSurplusMinW, 300, 5000),

    graceStartupSec: asNum(o.graceStartupSec, d.graceStartupSec, 60, 900),
    cutBuyW: asNum(o.cutBuyW, d.cutBuyW, 50, 1000),
    cutBuySustainSec: asNum(o.cutBuySustainSec, d.cutBuySustainSec, 0, 600),
    cutBuyHardW: asNum(o.cutBuyHardW, d.cutBuyHardW, 200, 3000),
    batteryDropCutPts: asNum(o.batteryDropCutPts, d.batteryDropCutPts, 2, 60),
    batteryFloorCutPct: asNum(o.batteryFloorCutPct, d.batteryFloorCutPct, 10, 90),

    sunElevStartDeg: asNum(o.sunElevStartDeg, d.sunElevStartDeg, 0, 60),
    sunAzStartDeg: asNum(o.sunAzStartDeg, d.sunAzStartDeg, 60, 180),
    sunElevEndDeg: asNum(o.sunElevEndDeg, d.sunElevEndDeg, 0, 60),
    sunAzEndDeg: asNum(o.sunAzEndDeg, d.sunAzEndDeg, 180, 320),
    degradedWindowEndH: asNum(o.degradedWindowEndH, d.degradedWindowEndH, 10, 20),

    hcEndTarget: asHm(o.hcEndTarget, d.hcEndTarget),
    hcPlanHour: asNum(o.hcPlanHour, d.hcPlanHour, 18, 23),
    hcMorningReservePct: asNum(o.hcMorningReservePct, d.hcMorningReservePct, 5, 80),
    hcGrey1Factor: asNum(o.hcGrey1Factor, d.hcGrey1Factor, 1, 3),
    hcGrey2Factor: asNum(o.hcGrey2Factor, d.hcGrey2Factor, 1, 3),

    apsStaleSec: asNum(o.apsStaleSec, d.apsStaleSec, 60, 3600),
    apsMuteFloorW: asNum(o.apsMuteFloorW, d.apsMuteFloorW, 5, 300),
    apsMuteConfirmSec: asNum(o.apsMuteConfirmSec, d.apsMuteConfirmSec, 60, 3600),
    apsTwinMinW: asNum(o.apsTwinMinW, d.apsTwinMinW, 50, 1000),
    reserveShowers: asNum(o.reserveShowers, d.reserveShowers, 0, 10),
    fullFraction: asNum(o.fullFraction, d.fullFraction, 0.5, 1),
    heatPowerW: asNum(o.heatPowerW, d.heatPowerW, 1000, 5000),
    sb1BatteryIndex: asNum(o.sb1BatteryIndex, d.sb1BatteryIndex, 0, 1),
    latDeg: asNum(o.latDeg, d.latDeg, -90, 90),
    lonDeg: asNum(o.lonDeg, d.lonDeg, -180, 180)
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
    drawWindowMin: asNum(o.drawWindowMin, d.drawWindowMin, 5, 120),
    drawStratFactor: asNum(o.drawStratFactor, d.drawStratFactor, 1, 6),
    probeFullRestC: asNum(o.probeFullRestC, d.probeFullRestC, 40, 70),
    indoorTopics: normTopics(o.indoorTopics, o.indoorTopic, d.indoorTopics),
    outdoorSources: normOutdoor(o.outdoorSources, d.outdoorSources)
  };
}

/** Liste de topics non vides ; replie sur l'ancien `indoorTopic` (string) puis le défaut. */
function normTopics(v: unknown, legacy: unknown, dflt: string[]): string[] {
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (arr.length) return arr;
  }
  if (typeof legacy === 'string' && legacy.trim()) return [legacy];
  return dflt;
}

function normOutdoor(v: unknown, d: OutdoorSourcesConfig): OutdoorSourcesConfig {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    daikin: typeof o.daikin === 'boolean' ? o.daikin : d.daikin,
    thermoExtTopic: typeof o.thermoExtTopic === 'string' ? o.thermoExtTopic : d.thermoExtTopic,
    forecast: typeof o.forecast === 'boolean' ? o.forecast : d.forecast
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
