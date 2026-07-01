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
    pvOnSbW,
    pvApsW,
    houseW,
    gridPowerW,
    cumulusPowerW,
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
  const autoconsoPct = base > 0 ? Math.round(((base - gridDrawW) / base) * 100) : 0;

  // ── 3. Coûts : SEULE la part EDF coûte cash (PV + batterie = autoconsommation) ──
  const priceNow = isHC ? priceHc : priceHp;
  const costNowPerKwh = base > 0 ? (gridDrawW / base) * priceNow : 0;
  const costHcPerKwh = priceHc; // référence : recharge HC de fin de nuit

  // ── 4. Signaux de décision ──
  const gridClean = gridDrawW <= config.gridTolW; // chauffer ne ponctionne (presque) pas EDF
  const purePv = pvCoverW >= base * config.purePvFraction && socOk; // PV seul couvre → surplus franc

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
