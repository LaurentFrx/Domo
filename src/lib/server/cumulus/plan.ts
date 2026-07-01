/**
 * Planificateur du chauffe-eau — MODÈLE AUTOCONSOMMATION (ÉTAPE 2b, SHADOW).
 *
 * Objectif (recadré 2026-07-01 par Laurent) : NE PAS ponctionner le réseau EDF, ou
 * le moins possible. L'apport instantané du système — sortie SolarBank plafonnée
 * ~2400 W (PV + batterie confondus) + APS EZ1 (injection directe, HORS plafond) —
 * doit couvrir la conso maison, CHAUFFE-EAU COMPRIS. Le levier : ÉTALER les charges
 * dans la journée pour qu'à chaque instant la conso reste sous ce que le solaire+
 * batterie peut fournir (ne pas empiler cumulus + induction + lave-vaisselle).
 *
 * À chaque tick on DÉCOMPOSE la chauffe (fiche docs/installation-energie.md) en :
 *   - pvCoverW      : PV net (production − conso maison) → GRATUIT (sinon écrêté : pas de revente)
 *   - batteryCoverW : batterie, dans la limite du PLAFOND de sortie SB, et SEULEMENT le
 *                     jour (PV actif → elle se recharge) au-dessus de la réserve du soir
 *                     → autoconsommation (~gratuit)
 *   - gridDrawW     : le RESTE = EDF ponctionné → le SEUL coût cash, à MINIMISER
 *
 * Vérifié sur mesure (01/07, chauffe réelle) : PV 806 W + batterie 1739 W + EDF 410 W
 * = 2955 W (reproduit les 430 W EDF / 1738 W batterie relevés ; sortie SB plafonnée 2399 W).
 *
 * La NUIT (PV inactif) la batterie EST la réserve du soir → on ne la puise PAS pour le
 * ballon : le repli passe par la HC de fin de nuit (EDF bon marché), pas par la batterie.
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
  setpointC: number; // consigne du thermostat (~59 °C) — pour le péage de stockage

  // ── Flux réels (EM-50 = autoritaire ; Anker = ~60 s de latence) ──
  pvOnSbW: number; // PV sur SolarBank (soumis au plafond de sortie SB) — Anker solar_power_w
  pvApsW: number; // PV du micro-onduleur APS EZ1 (injection directe, HORS plafond)
  houseW: number; // conso maison HORS chauffe-eau (W, ≥ 0)
  gridPowerW: number; // réseau signé (+ import EDF / − export) — EM-50 voie 0
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
const PV_ACTIVE_W = 300; // PV total au-dessus → « il fait jour » (batterie rechargeable → puisable)

/** Heures (positives) jusqu'au prochain 7 h 30. */
function hoursUntil(hour: number, target: number): number {
  let d = target - hour;
  if (d < 0) d += 24;
  return d;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

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
    setpointC,
    pvOnSbW,
    pvApsW,
    houseW,
    gridPowerW,
    cumulusPowerW,
    batteryEnergyWh,
    batteryDischargeW,
    socPct,
    isHC,
    priceHp,
    priceHc,
    forecast
  } = input;

  const HEAT_W = config.heatPowerW; // ~2955 W réels
  const pvTotalW = Math.max(0, pvOnSbW) + Math.max(0, pvApsW);
  const showers = eDoucheWh > 0 ? eAvailWh / eDoucheWh : 0;

  // ── 1. Besoin daté : énergie à garantir à 7 h 30 (2 douches) + pertes d'ici là ──
  const hToMorning = hoursUntil(hourOfDay, MORNING_H);
  const lossPerH = Math.max(0, lossCoeffWhPerCh * Math.max(0, tTankC - tRoomC)); // Wh/h
  const lossToMorning = lossPerH * hToMorning;
  const targetMorningWh = config.reserveShowers * eDoucheWh;
  const eAvailMorning = Math.max(0, eAvailWh - lossToMorning); // été : pas de puisage nocturne
  const deficitWh = Math.max(0, targetMorningWh - eAvailMorning);

  // ── 2. Décomposition de la chauffe : PV gratuit / batterie autoconso / EDF ──
  //   Le SIGNAL AUTORITAIRE du soutirage EDF est l'EM-50 (LOCAL, instantané ~180 ms),
  //   PAS une projection via l'Anker (cloud, ~60 s de retard).
  const heatingNow = cumulusPowerW > 500; // le ballon chauffe DÉJÀ → on LIT le réel
  const gridNowW = Math.round(gridPowerW); // soutirage EDF RÉEL instantané (EM-50 voie 0)
  const daytime = pvTotalW > PV_ACTIVE_W;
  const socOk = socPct !== null && socPct > config.socReservePct;

  let base: number, pvCoverW: number, batteryCoverW: number, gridDrawW: number;
  if (heatingNow) {
    // Ballon en chauffe → décomposition MESURÉE : EDF = grid EM-50 réel, batterie = décharge réelle.
    base = cumulusPowerW;
    gridDrawW = Math.max(0, gridNowW);
    batteryCoverW = clamp(batteryDischargeW, 0, base - gridDrawW);
    pvCoverW = Math.max(0, base - gridDrawW - batteryCoverW); // le reste = PV (par différence)
  } else {
    // Ballon à l'arrêt → PROJECTION « si on démarrait » (le grid réel ne voit pas le surplus
    // qui charge la batterie, faute de revente) : sortie SB plafonnée + APS hors plafond.
    base = HEAT_W;
    pvCoverW = clamp(pvTotalW - houseW, 0, HEAT_W); // PV net (gratuit, sinon écrêté)
    const batteryHeadroomW =
      socOk && daytime ? Math.max(0, config.sbOutMaxW - Math.max(0, pvOnSbW)) : 0;
    batteryCoverW = clamp(HEAT_W - pvCoverW, 0, batteryHeadroomW);
    gridDrawW = Math.max(0, HEAT_W - pvCoverW - batteryCoverW);
  }

  // ── 3. Signaux de décision ──
  const purePv = pvCoverW >= base * config.purePvFraction && socOk; // PV seul couvre → surplus franc

  // ── 3bis. Réserve du soir CALCULÉE (remplace tout % fixe) : la batterie doit
  //    couvrir la maison entre la fin du solaire (~17 h au plus tôt) et 00 h 06.
  //    Le matin (< 8 h) le PV du jour va la recharger → seul le plancher SoC dur s'applique.
  const eveningHours = hourOfDay >= 8 ? Math.max(0, 24.1 - Math.max(hourOfDay, 17)) : 0;
  const dinnerAhead = hourOfDay >= 8 && hourOfDay < 20.5;
  const eveningNeedWh = Math.round(
    config.eveningBaseW * eveningHours + (dinnerAhead ? config.dinnerWh : 0)
  );
  // Une chauffe type puiserait batteryCoverW × durée : si la batterie n'y survit pas
  // avec sa réserve du soir, cette part bascule sur EDF (et la décision suivra le coût).
  const heatH = Math.min(2, Math.max(0.5, (deficitWh > 0 ? deficitWh : 2000) / HEAT_W));
  if (!heatingNow && !purePv && batteryCoverW > 0) {
    const batteryAfterHeatWh = batteryEnergyWh - batteryCoverW * heatH;
    if (batteryAfterHeatWh < eveningNeedWh) {
      gridDrawW += batteryCoverW; // la batterie est réservée au soir → l'appoint serait de l'EDF
      batteryCoverW = 0;
    }
  }
  const autoconsoPct = base > 0 ? Math.round(((base - gridDrawW) / base) * 100) : 0;

  // ── 3ter. Péage de stockage : chauffer tôt = pertes jusqu'à l'usage (7 h 30) ──
  const lossAfterHeatPerH = Math.max(0, lossCoeffWhPerCh * Math.max(0, setpointC - tRoomC)); // Wh/h ballon chaud
  const storageLossWh = Math.round(lossAfterHeatPerH * hToMorning);
  const refHeatWh = Math.max(2000, deficitWh); // taille de chauffe de référence
  const lossFracNow = Math.min(0.4, storageLossWh / (refHeatWh + storageLossWh));
  const lossFracHc = Math.min(0.4, (lossAfterHeatPerH * 0.75) / refHeatWh); // HC finit ~45 min avant l'usage

  // ── 4. Coûts du kWh UTILE (celui qui sort du mitigeur) ──
  //   EDF au tarif de l'heure + batterie à son COÛT D'OPPORTUNITÉ (le kWh qu'il faudra
  //   racheter en HC pour la remplacer — ~0 si l'écrêtage la re-remplit gratuitement),
  //   le tout grevé du péage de stockage.
  const priceNow = isHC ? priceHc : priceHp;
  const battOppEurPerKwh = purePv ? 0 : priceHc;
  const costAcqNow =
    base > 0 ? (gridDrawW * priceNow + batteryCoverW * battOppEurPerKwh) / base : 0;
  const costNowPerKwh = costAcqNow / (1 - lossFracNow);
  const costHcPerKwh = priceHc / (1 - lossFracHc); // référence : recharge HC de fin de nuit

  const gridClean = gridDrawW <= config.gridTolW; // chauffer ne ponctionne (presque) pas EDF

  // ── 5. Backstop HC : heure au plus tard pour démarrer et finir ~7 h 30 ──
  const backstopHour = MORNING_H - deficitWh / HEAT_W - 0.25; // marge 15 min
  const solarComingToday =
    hourOfDay < 18 &&
    forecast.some((p) => p.hoursAhead > 0 && p.hour < 19 && p.pvW >= config.peakMinW);

  // ── 6. Décision (priorité décroissante) ──
  const mk = (action: PlanAction, reason: string, targetHour: number | null = null): HeatPlan => ({
    action,
    reason,
    targetHour,
    showers: +showers.toFixed(1),
    floorShowers: config.reserveShowers,
    deficitWh: Math.round(deficitWh),
    gridNowW,
    measured: heatingNow,
    pvCoverW: Math.round(pvCoverW),
    batteryCoverW: Math.round(batteryCoverW),
    gridDrawW: Math.round(gridDrawW),
    autoconsoPct,
    eveningNeedWh,
    storageLossWh,
    costNowEur: +costNowPerKwh.toFixed(3),
    costHcEur: +costHcPerKwh.toFixed(3),
    backstopHcHour: deficitWh > 0 ? +backstopHour.toFixed(1) : null,
    computedAt: now
  });

  const full = eFullWh > 0 && eAvailWh >= eFullWh * config.fullFraction;

  // a) Évidence : ballon plein → rien à faire
  if (full) return mk('wait', 'ballon plein — rien à faire');

  // b) Surplus solaire FRANC : le PV seul couvre l'essentiel → gratuit (sinon écrêté) → autoconsommer
  if (purePv)
    return mk(
      'heat_now',
      `surplus solaire (${autoconsoPct} % autoconso, EDF ${Math.round(gridDrawW)} W) — on remplit gratuitement`,
      Math.floor(hourOfDay)
    );

  // c) Besoin daté : garantir les 2 douches du matin, au MOINDRE soutirage EDF
  if (deficitWh > 0) {
    // Solaire + batterie couvrent déjà (≈ pas d'EDF) → chauffer maintenant (autoconsommation)
    if (gridClean && socOk)
      return mk(
        'heat_now',
        `besoin ${Math.round(deficitWh)} Wh couvert par le solaire (${autoconsoPct} % autoconso) — chauffe`,
        Math.floor(hourOfDay)
      );
    // Pas couvert maintenant, mais du solaire arrive → attendre le pic (EDF minimal)
    if (solarComingToday) {
      const peak = forecast.find((p) => p.hoursAhead > 0 && p.pvW >= config.peakMinW) ?? null;
      return mk(
        'wait_solar',
        `déficit ${Math.round(deficitWh)} Wh — attendre le solaire (chauffer maintenant = ${Math.round(gridDrawW)} W EDF)`,
        peak ? peak.hour : null
      );
    }
    // Ni couverture solaire ni solaire à venir → filet HC de fin de nuit (EDF bon marché)
    if (isHC && hourOfDay >= backstopHour)
      return mk('heat_hc', `recharge heures creuses — ${Math.round(deficitWh)} Wh pour le matin`);
    if (isHC)
      return mk(
        'wait',
        `creuses — on attend ${backstopHour.toFixed(1)} h pour finir juste à temps (pertes mini)`,
        Math.ceil(backstopHour)
      );
    return mk('wait', `déficit ${Math.round(deficitWh)} Wh — ni solaire ni HC pour l'instant`);
  }

  // d) Réserve suffisante et pas de surplus franc → attendre (ne pas vider la batterie pour rien)
  return mk('wait', `réserve ${showers.toFixed(1)} douches OK — on attend le surplus solaire`);
}
