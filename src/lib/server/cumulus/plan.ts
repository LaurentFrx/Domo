/**
 * Planificateur prédictif de chauffe du cumulus (ÉTAPE 2a — SHADOW).
 *
 * `planHeating(input, config)` est PUR (aucune I/O) : il prend un instantané
 * (E_avail, courbe PV horaire à venir, tarif HP/HC, SoC batterie) et retourne un
 * PLAN de chauffe (heat_now / wait_solar / heat_hc / wait) avec sa raison.
 *
 * Il NE COMMANDE RIEN. En phase shadow, le plan est seulement journalisé + exposé
 * à l'UI ; `decide.ts` n'est pas branché dessus. But : prouver que le plan décide
 * « comme Laurent » avant de lui confier le relais (étape 2c).
 *
 * Stratégie (choix de Laurent, 2026-06-29) :
 *   - SURPLUS PV : viser le PIC PV de la journée (l'heure la plus productive), avec
 *     une marge batterie (pas de chauffe solaire si SoC < socFloorPct — la batterie
 *     se recharge d'abord pour le soir).
 *   - RÉSERVE : garder ≥ reserveShowers douches ; en dessous, recharger — au pic PV
 *     s'il arrive à temps, sinon en heures creuses.
 */

import type { HeatPlan, PlanAction, PlannerConfig, PlanForecastPoint } from './types';

// PlanForecastPoint vit dans types.ts (partagé avec CumulusInputs.forecastHourly) ; réexporté ici.
export type { PlanForecastPoint };

/** Instantané d'entrée du planificateur (construit par engine.ts depuis les inputs). */
export interface PlanInput {
  now: number;
  eAvailWh: number;
  eFullWh: number;
  eDoucheWh: number; // énergie d'une douche (interpolée saison, issue du modèle d'énergie)
  isHC: boolean;
  socPct: number | null; // SoC batterie moyen (%), null si indisponible
  forecast: PlanForecastPoint[]; // courbe PV à venir ; vide si prévision indisponible
}

/** Calcule le plan de chauffe (pur). */
export function planHeating(input: PlanInput, config: PlannerConfig): HeatPlan {
  const { now, eAvailWh, eFullWh, eDoucheWh, isHC, socPct, forecast } = input;

  const showers = eDoucheWh > 0 ? eAvailWh / eDoucheWh : 0;
  const mk = (action: PlanAction, reason: string, targetHour: number | null = null): HeatPlan => ({
    action,
    reason,
    targetHour,
    showers: +showers.toFixed(1),
    floorShowers: config.reserveShowers,
    computedAt: now
  });

  // 1) Ballon ~plein → rien à planifier.
  if (eFullWh > 0 && eAvailWh >= eFullWh * config.fullFraction) {
    return mk('wait', 'ballon plein');
  }

  // 2) Caractérise la prévision PV de l'horizon.
  const future = forecast.filter((p) => p.hoursAhead >= 0 && p.hoursAhead <= config.horizonH);
  const peakW = future.reduce((m, p) => Math.max(m, p.pvW), 0);
  const nowPt = future.find((p) => p.hoursAhead === 0) ?? null;
  const nowPvW = nowPt ? nowPt.pvW : 0;
  // Seuil « pic » : une fraction du pic du jour, ET une puissance absolue suffisante
  // pour réellement chauffer (sinon on n'enclenche pas pour 200 W).
  const peakThreshold = Math.max(config.peakMinW, peakW * config.peakFraction);
  const inPeak = peakW > 0 && nowPvW >= peakThreshold;
  const nextPeak = future.find((p) => p.hoursAhead > 0 && p.pvW >= peakThreshold) ?? null;

  const batteryOk = socPct === null || socPct >= config.socFloorPct;

  // 3) On est dans le pic PV.
  if (inPeak) {
    if (batteryOk) {
      return mk('heat_now', `pic PV (${Math.round(nowPvW)} W) — chauffe solaire`, nowPt!.hour);
    }
    return mk(
      'wait',
      `pic PV mais batterie ${socPct}% < ${config.socFloorPct}% — priorité recharge batterie`
    );
  }

  // 4) Réserve sous le plancher → il faut recharger.
  if (showers < config.reserveShowers) {
    if (nextPeak) {
      return mk(
        'wait_solar',
        `réserve ${showers.toFixed(1)} douches — pic PV prévu dans ${nextPeak.hoursAhead} h`,
        nextPeak.hour
      );
    }
    if (isHC) {
      return mk(
        'heat_hc',
        `réserve ${showers.toFixed(1)} douches, pas de soleil suffisant — chauffe heures creuses`
      );
    }
    return mk(
      'wait',
      `réserve ${showers.toFixed(1)} douches, ni soleil ni HC — attend les creuses`
    );
  }

  // 5) Réserve OK, hors pic → garder la place pour le solaire gratuit.
  return mk('wait', `réserve ${showers.toFixed(1)} douches OK — attend le pic PV`);
}
