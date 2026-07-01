/**
 * Planificateur du chauffe-eau — MODÈLE ÉCONOMIQUE (ÉTAPE 2b, SHADOW).
 *
 * `planHeating(input, config)` est PUR. Il ne pose PAS de seuils empilés : il
 * RAISONNE EN COÛT. À chaque tick il compare le coût d'obtenir l'énergie qu'il
 * faut dans le ballon (chauffer maintenant sur surplus solaire vs plus tard vs
 * heures creuses de fin de nuit), sous les contraintes réelles de l'installation
 * (fiche docs/installation-energie.md), et retourne l'action + sa valeur économique.
 *
 * Principes (fiche) :
 *   - Pas de revente → tout surplus PV non consommé est PERDU. L'autoconsommer
 *     dans le ballon vaut toujours mieux que le perdre (coût ≈ 0 €).
 *   - Le ballon (~2955 W réels) > production solaire max (~2,6 kW) → chauffer « au
 *     solaire » ponctionne toujours un peu de batterie/réseau : c'est chiffré, pas masqué.
 *   - La batterie est la réserve du soir : un kWh batterie mis dans le ballon = un
 *     kWh racheté plus tard (coût d'opportunité ≈ HC).
 *   - Besoin daté : garantir 2 douches à ~7 h 30. La HC de fin de nuit (fin 08 h 06)
 *     est le FILET quasi parfait (eau fraîche à temps, tarif bas, pertes ~nulles).
 *   - Angle mort : le surplus libre n'est pas mesurable directement (batterie pleine
 *     + PV écrêté → import ≈ 0). On l'INFÈRE (batterie pleine/idle + pas d'import +
 *     PV actif) avec un niveau de CONFIANCE ; on ne le masque pas.
 *
 * NE PILOTE RIEN : shadow (journalisé + carte). Le relais reste manuel.
 */

import type { HeatPlan, PlanAction, PlannerConfig, PlanForecastPoint } from './types';

export type { PlanForecastPoint };

/** Instantané d'entrée du modèle (construit par engine.ts depuis les inputs réels). */
export interface PlanInput {
  now: number;
  hourOfDay: number; // heure locale Paris, fractionnaire (0–24)

  // ── Ballon ──
  eAvailWh: number;
  eFullWh: number;
  eDoucheWh: number; // énergie d'une douche (saisonnière)
  tTankC: number; // température moyenne estimée du ballon
  tRoomC: number; // température du local
  lossCoeffWhPerCh: number; // pertes Wh/h par °C

  // ── Flux réels (EM-50 = autoritaire ; Anker = ~60 s de latence) ──
  pvTotalW: number; // production PV TOTALE (SolarBank + APS Sud)
  houseW: number; // conso maison HORS chauffe-eau (W, ≥ 0)
  gridPowerW: number; // réseau signé (+ import / − export) — EM-50 voie 0
  cumulusPowerW: number; // conso chauffe-eau mesurée (> ~500 = en chauffe)
  batteryEnergyWh: number; // énergie batterie réelle
  batteryChargeW: number; // charge batterie (W ≥ 0 = surplus absorbé)
  batteryDischargeW: number; // décharge batterie (W ≥ 0)
  socPct: number | null; // SoC moyen (%)

  // ── Tarif ──
  isHC: boolean;
  priceHp: number; // €/kWh
  priceHc: number; // €/kWh

  // ── Prévision PV (potentiel horaire à venir) ──
  forecast: PlanForecastPoint[];
}

const MORNING_H = 7.5; // deadline besoin : 2 douches à ~7 h 30
const HC_END_H = 8.1; // fin des heures creuses (08 h 06)

/** Heures (positives) jusqu'au prochain 7 h 30. */
function hoursUntil(hour: number, target: number): number {
  let d = target - hour;
  if (d < 0) d += 24;
  return d;
}

export function planHeating(input: PlanInput, config: PlannerConfig): HeatPlan {
  const {
    now,
    hourOfDay,
    eAvailWh,
    eFullWh,
    eDoucheWh,
    tTankC,
    tRoomC,
    lossCoeffWhPerCh,
    pvTotalW,
    houseW,
    gridPowerW,
    cumulusPowerW,
    batteryEnergyWh,
    batteryChargeW,
    batteryDischargeW,
    socPct,
    isHC,
    priceHp,
    priceHc,
    forecast
  } = input;

  const HEAT_W = config.heatPowerW; // ~2955 W réels
  const showers = eDoucheWh > 0 ? eAvailWh / eDoucheWh : 0;

  // ── 1. Besoin daté : énergie à garantir à 7 h 30 (2 douches) + pertes d'ici là ──
  const hToMorning = hoursUntil(hourOfDay, MORNING_H);
  const lossPerH = Math.max(0, lossCoeffWhPerCh * Math.max(0, tTankC - tRoomC)); // Wh/h
  const lossToMorning = lossPerH * hToMorning;
  const targetMorningWh = config.reserveShowers * eDoucheWh;
  const eAvailMorning = Math.max(0, eAvailWh - lossToMorning); // été : pas de puisage nocturne
  const deficitWh = Math.max(0, targetMorningWh - eAvailMorning);

  // ── 2. Surplus libre : inférence binaire + confiance (angle mort n°1) ──
  const pvActive = pvTotalW > 200;
  const noImport = gridPowerW <= 60;
  const socFull = socPct !== null && socPct >= config.freeSurplusSocPct;
  const chargeIdle = batteryChargeW < 120; // la batterie ne stocke (quasi) plus
  const surplusFree = pvActive && noImport && (socFull || (chargeIdle && (socPct ?? 0) >= 90));
  const confidence: HeatPlan['surplusConfidence'] = surplusFree
    ? socFull && gridPowerW <= 0
      ? 'haute'
      : 'moyenne'
    : 'nulle';
  // Marge PV visible (le surplus réel écrêté est ≥ ça, non mesurable).
  const freeMarginW = surplusFree ? Math.max(0, pvTotalW - houseW) : 0;

  // ── 3. Coût de chauffer MAINTENANT vs HC (par kWh chauffé) ──
  const pvCoverW = Math.max(0, Math.min(HEAT_W, pvTotalW - houseW));
  const applianceW = Math.max(0, HEAT_W - pvCoverW); // appoint batterie/réseau
  // Sur surplus libre : le PV écrêté (sinon perdu) alimente le ballon → ~0 € ;
  // hors surplus : l'appoint vient de la batterie (coût d'opportunité ≈ HC) ou du réseau.
  const priceNow = isHC ? priceHc : priceHp;
  const costNowPerKwh = surplusFree
    ? (applianceW / HEAT_W) * priceHc * 0.3 // appoint marginal, batterie rechargée par l'écrêté
    : (pvCoverW * 0 + applianceW * (isHC ? priceHc : priceNow)) / HEAT_W;
  const costHcPerKwh = priceHc; // référence : recharge HC de fin de nuit

  // ── 4. Réserve batterie du soir (remplace socFloorPct brut) ──
  const batteryOkForHeat = batteryEnergyWh > config.eveningReserveWh || surplusFree;

  // ── 5. Interlock 6 kVA (délestage) : ajouter la chauffe frôlerait-il le plafond ? ──
  const projectedImportW = gridPowerW + applianceW;
  const overload = projectedImportW > config.maxImportW;

  // ── 6. Backstop HC : heure au plus tard pour démarrer et finir ~7 h 30 ──
  const heatHoursForDeficit = deficitWh / HEAT_W; // durée de chauffe nécessaire
  const backstopHour = MORNING_H - heatHoursForDeficit - 0.25; // marge 15 min
  const solarComingToday =
    hourOfDay < 18 &&
    forecast.some((p) => p.hoursAhead > 0 && p.hour < 19 && p.pvW >= config.peakMinW);

  // ── 7. Décision (pile pondérée, priorité décroissante) ──
  const mk = (action: PlanAction, reason: string, targetHour: number | null = null): HeatPlan => ({
    action,
    reason,
    targetHour,
    showers: +showers.toFixed(1),
    floorShowers: config.reserveShowers,
    deficitWh: Math.round(deficitWh),
    surplusFreeW: surplusFree ? Math.round(freeMarginW) : -1,
    surplusConfidence: confidence,
    applianceW: Math.round(applianceW),
    costNowEur: +costNowPerKwh.toFixed(3),
    costHcEur: +costHcPerKwh.toFixed(3),
    backstopHcHour: deficitWh > 0 ? +backstopHour.toFixed(1) : null,
    computedAt: now
  });

  const full = eFullWh > 0 && eAvailWh >= eFullWh * config.fullFraction;

  // a) Sécurités / évidences
  if (full) return mk('wait', 'ballon plein — rien à faire');
  if (overload)
    return mk('wait', `conso maison élevée (${Math.round(houseW)} W) — chauffe différée (6 kVA)`);

  // b) Opportunité gratuite : surplus libre + place dans le ballon → autoconsommer (sinon perdu)
  if (surplusFree && batteryOkForHeat) {
    return mk(
      'heat_now',
      `surplus solaire ~gratuit (confiance ${confidence}, appoint ${Math.round(applianceW)} W) — autoconsommation`,
      Math.floor(hourOfDay)
    );
  }

  // c) Besoin daté : garantir les 2 douches du matin, au moindre coût
  if (deficitWh > 0) {
    if (solarComingToday) {
      const peak = forecast.find((p) => p.hoursAhead > 0 && p.pvW >= config.peakMinW) ?? null;
      return mk(
        'wait_solar',
        `déficit ${Math.round(deficitWh)} Wh — attendre le solaire (moins cher que HC)`,
        peak ? peak.hour : null
      );
    }
    if (isHC && hourOfDay >= backstopHour) {
      return mk('heat_hc', `recharge heures creuses — ${Math.round(deficitWh)} Wh pour le matin`);
    }
    if (isHC) {
      return mk(
        'wait',
        `creuses — on attend ${backstopHour.toFixed(1)} h pour finir juste à temps (pertes mini)`,
        Math.ceil(backstopHour)
      );
    }
    return mk('wait', `déficit ${Math.round(deficitWh)} Wh — ni soleil ni HC pour l'instant`);
  }

  // d) Réserve suffisante, pas de gratuit dispo → garder la place pour le solaire à venir
  return mk('wait', `réserve ${showers.toFixed(1)} douches OK — on garde la place pour le gratuit`);
}
