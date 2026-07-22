/**
 * PILOTE V2 du chauffe-eau — machine à phases « règle zéro achat EDF ».
 * Spec : docs/conception-pilotage-cumulus-v2.md, annotée et VALIDÉE par Laurent le 03/07/2026.
 *
 * RÈGLE D'OR (aucune exception économique) : le chauffe-eau ne doit JAMAIS être la
 * cause d'un achat de courant à EDF. On l'allume quand la maison donne gratuitement
 * au réseau (énergie perdue, pas de revente) ou sur surplus invisible estimé ; on
 * l'éteint dès que la maison a besoin de sa puissance. Deux exceptions assumées :
 * la grâce de démarrage (latence SolarBank 2-3 min ≈ 100 Wh) et la recharge HC.
 *
 * HIÉRARCHIE DES SOURCES (leçon de l'échec V1 du 02/07) :
 *   - EM50 (instantané) = SEULE source des décisions d'allumage/coupure ;
 *   - cloud Anker (~1 min de retard) = conditions LENTES uniquement (SoC) — sa
 *     production affichée MENT en bridage, INTERDITE comme condition d'allumage ;
 *   - APS local = étalon du potentiel (voir solar-potential.ts) ;
 *   - météo = UNIQUEMENT la décision nocturne de recharge HC.
 *
 * ARCHITECTURE : la « phase » est DÉRIVÉE du relais réel + de l'état (jamais
 * désynchronisée) ; la mémoire de la machine (chronos de persistance, compteurs,
 * cause de cession, plan HC) vit dans PilotState. `pilotStep()` est PUR : il rend
 * wantOn (ce que le pilote ferait), la vue UI, les événements de journal, et le
 * nouvel état. En OBSERVATION, engine/decide n'appliquent pas wantOn — la machine
 * suit alors le relais MANUEL réel et journalise « aurait allumé / aurait coupé »,
 * ce qui en fait le banc de validation.
 */

import type {
  CumulusInputs,
  CumulusConfig,
  CumulusRuntimeState,
  PilotState,
  PilotView,
  PilotPhase,
  PilotConfig,
  CessionCause,
  HcPlan,
  ShadowEvent
} from './types';
import { sunPosition } from './sun.ts';
import type { PotentialResult } from './solar-potential';

const SEC = 1000;
const HC_START_MIN = 6; // 00:06 — ouverture des heures creuses
const HC_HARD_END_MIN = 7 * 60 + 30; // 07:30 — fin dure de la fenêtre d'exécution HC

/** Contexte du tick fourni par engine (jauge d'eau du modèle calorimétrique, heure locale). */
export interface PilotCtx {
  eAvailWh: number;
  eFullWh: number;
  eDoucheWh: number;
  lossPerHWh: number; // pertes actuelles du ballon (Wh/h)
  hourLocal: number; // heure locale Paris fractionnaire (0-24)
  minuteOfDay: number; // minutes locales depuis minuit (0-1439)
  tomorrowParis: string; // date Paris de demain 'YYYY-MM-DD'
  potential: PotentialResult; // estimateur de potentiel solaire (surplus invisible)
}

export interface PilotStepResult {
  wantOn: boolean;
  reason: 'solar' | 'hc' | 'wait';
  view: PilotView;
  events: ShadowEvent[];
  pilot: PilotState;
}

export function defaultPilotState(): PilotState {
  return {
    condsSinceTs: null,
    buyOverSinceTs: null,
    socStartOfHeat: null,
    startsDate: '',
    solarStartsToday: 0,
    resumesToday: 0,
    lastCessionCause: null,
    lastCessionTs: null,
    hcPlan: null,
    wouldOnSinceTs: null,
    apsLowSinceTs: null,
    apsAlert: 'none',
    sunWindow: null
  };
}

/**
 * Fenêtre solaire du jour, en horaires locaux (HH:MM) — dérivée des éphémérides
 * (mêmes seuils élévation/azimut que la décision d'allumage), balayée sur toute la
 * journée calendaire. `minuteOfDay` sert à retrouver le minuit local approximatif
 * (précision à la minute, largement suffisante : le soleil bouge lentement).
 * Ne dépend que de la date + lat/lon + seuils → calculée UNE FOIS par jour.
 */
function computeSunWindowToday(
  now: number,
  minuteOfDay: number,
  p: PilotConfig
): { startMin: number; endMin: number } | null {
  const localMidnightTs = now - minuteOfDay * 60_000;
  let startMin: number | null = null;
  let endMin: number | null = null;
  for (let m = 0; m < 24 * 60; m += 5) {
    const s = sunPosition(localMidnightTs + m * 60_000, p.latDeg, p.lonDeg);
    const open =
      s.elevationDeg > p.sunElevStartDeg &&
      s.azimuthDeg >= p.sunAzStartDeg &&
      s.elevationDeg >= p.sunElevEndDeg &&
      s.azimuthDeg <= p.sunAzEndDeg;
    if (open) {
      if (startMin === null) startMin = m;
      endMin = m;
    }
  }
  if (startMin === null || endMin === null) return null;
  return { startMin, endMin: Math.min(24 * 60 - 1, endMin + 5) };
}

const hmToMin = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const minToHm = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

export function pilotStep(
  inputs: CumulusInputs,
  config: CumulusConfig,
  state: CumulusRuntimeState,
  ctx: PilotCtx
): PilotStepResult {
  const p = config.pilot;
  const now = inputs.now;
  const pilot: PilotState = { ...state.pilot };
  const events: ShadowEvent[] = [];
  const observation = config.observationMode;

  // ── Remise à zéro des compteurs au changement de jour ──
  if (pilot.startsDate !== inputs.todayParis) {
    pilot.startsDate = inputs.todayParis;
    pilot.solarStartsToday = 0;
    pilot.resumesToday = 0;
  }

  const heatingNow = inputs.em50Available && inputs.cumulusPowerW > 500;
  const buyW = Math.max(0, Math.round(inputs.gridPowerW)); // achat EDF réel (EM50 voie 0)
  const exportW = Math.max(0, Math.round(-inputs.gridPowerW)); // don au réseau réel
  const socs = inputs.batterySocPct.filter((s) => Number.isFinite(s));
  const socAvg = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null;
  const relayOn = inputs.relayOn === true;
  const onForMs = state.onSinceTs !== null ? now - state.onSinceTs : 0;
  const inGrace = relayOn && onForMs < p.graceStartupSec * SEC;

  // ── Fenêtre solaire par éphémérides (dérivée chaque jour, pas d'heures en dur) ──
  const sun = sunPosition(now, p.latDeg, p.lonDeg);
  const degradedEnd = !inputs.ankerAvailable && ctx.hourLocal >= p.degradedWindowEndH;
  const windowStarted = sun.elevationDeg > p.sunElevStartDeg && sun.azimuthDeg >= p.sunAzStartDeg;
  const windowEnded =
    sun.elevationDeg < p.sunElevEndDeg || sun.azimuthDeg > p.sunAzEndDeg || degradedEnd;
  const windowOpen = windowStarted && !windowEnded;
  // Minutes de fenêtre restantes (échantillonnage 10 min, horizon 10 h)
  let windowLeftMin = 0;
  if (windowOpen) {
    for (let m = 10; m <= 600; m += 10) {
      const s = sunPosition(now + m * 60_000, p.latDeg, p.lonDeg);
      const ended =
        s.elevationDeg < p.sunElevEndDeg ||
        s.azimuthDeg > p.sunAzEndDeg ||
        (!inputs.ankerAvailable && ctx.hourLocal + m / 60 >= p.degradedWindowEndH);
      if (ended) break;
      windowLeftMin = m;
    }
  }

  // Fenêtre du jour (horaires HH:MM) — calculée une fois par jour, mise en cache
  // (ne dépend que de la date + lat/lon + seuils, pas de l'instant courant).
  if (pilot.sunWindow?.forDate !== inputs.todayParis) {
    const w = computeSunWindowToday(now, ctx.minuteOfDay, p);
    pilot.sunWindow = {
      forDate: inputs.todayParis,
      startMin: w?.startMin ?? -1,
      endMin: w?.endMin ?? -1
    };
  }
  const sunWindow = pilot.sunWindow;
  const sunWindowStart = sunWindow && sunWindow.startMin >= 0 ? minToHm(sunWindow.startMin) : null;
  const sunWindowEnd = sunWindow && sunWindow.endMin >= 0 ? minToHm(sunWindow.endMin) : null;
  const sunWindowNote = !inputs.ankerAvailable
    ? `resserrée à ${minToHm(p.degradedWindowEndH * 60)} tant que le cloud Anker reste injoignable`
    : '';

  // ── Plan de recharge HC (calculé le soir à hcPlanHour ; secours après minuit) ──
  const besoinStrictWh = p.reserveShowers * ctx.eDoucheWh;
  if (ctx.hourLocal >= p.hcPlanHour && pilot.hcPlan?.forDate !== ctx.tomorrowParis) {
    pilot.hcPlan = computeHcPlan(ctx.tomorrowParis, inputs, config, ctx, besoinStrictWh, now);
    events.push({
      ts: now,
      kind: 'phase',
      label: 'plan nuit',
      detail: pilot.hcPlan
        ? `recharge ${minToHm(pilot.hcPlan.startMin)} → ${p.hcEndTarget} (${Math.round(pilot.hcPlan.targetWh / 100) / 10} kWh visés) — ${pilot.hcPlan.reason}`
        : 'rien à recharger cette nuit (réserve suffisante)'
    });
  } else if (
    ctx.hourLocal < 8 &&
    pilot.hcPlan?.forDate !== inputs.todayParis &&
    pilot.hcPlan?.forDate !== ctx.tomorrowParis
  ) {
    // Secours (redémarrage nocturne) : plan pour CE matin
    pilot.hcPlan = computeHcPlan(inputs.todayParis, inputs, config, ctx, besoinStrictWh, now);
  }

  // ── Régime HC actif ? (fenêtre d'exécution du plan nocturne) ──
  const hcPlanActive =
    pilot.hcPlan !== null &&
    pilot.hcPlan.forDate === inputs.todayParis &&
    ctx.minuteOfDay >= Math.max(HC_START_MIN, pilot.hcPlan.startMin) &&
    ctx.minuteOfDay < Math.min(HC_HARD_END_MIN, pilot.hcPlan.endMin);
  const hcTargetReached =
    pilot.hcPlan !== null &&
    (ctx.eAvailWh >= pilot.hcPlan.targetWh ||
      (socAvg !== null && socAvg <= p.hcMorningReservePct && ctx.eAvailWh >= pilot.hcPlan.minWh));
  const hcWants = hcPlanActive && !hcTargetReached;

  // ── Les 7 conditions d'allumage solaire (affichées telles quelles dans l'UI) ──
  const tankNotFull =
    ctx.eFullWh > 0 && ctx.eAvailWh < p.fullFraction * ctx.eFullWh && !state.ballonCharged;
  // L'axiome « l'export prouve la saturation du parc » ne tient que si la
  // régulation zéro-export de la Max AC est VIVANTE (mesure locale up). Si elle
  // est muette — et l'événement qui la rend muette peut être celui qui a tué la
  // régulation — l'export redevient un débordement ordinaire : on ré-exige la
  // garde historique « batteries pleines » (cloud), neutralisée seulement si le
  // cloud aussi est muet (mode dégradé historique, fenêtre resserrée à 15 h).
  const exportProof =
    inputs.maxAcAvailable ||
    !inputs.ankerAvailable ||
    (socAvg !== null && socAvg >= p.battFullPct && inputs.batteryChargeW < p.chargeIdleW);
  const exportFrank = inputs.em50Available && exportW > p.exportOnW && exportProof;
  const quietHouse = !inputs.appliances.some((a) => a.powerW !== null && a.powerW >= a.onW);
  const windowOk = windowOpen && inputs.pvApsW >= p.apsMinW && windowLeftMin >= p.minUsefulHeatMin;
  const resumeFree = pilot.lastCessionCause === 'buy' || pilot.lastCessionCause === 'hard_buy';
  const quotaOk = resumeFree || pilot.solarStartsToday < p.solarStartsPerDay;
  const delaysOk =
    (state.lastOffTs === null || now - state.lastOffTs >= config.minOffSec * SEC) &&
    (state.lastTransitionTs === null ||
      now - state.lastTransitionTs >= config.antiCyclingSec * SEC);

  // ── ALERTE « APS MUET » : l'étalon de toute la détection solaire est-il vivant ? ──
  // Deux niveaux, jugés SEULEMENT fenêtre solaire ouverte (la nuit, un APS éteint est normal).
  //   - « injoignable » : le bridge ne répond plus / données périmées ;
  //   - « panne probable » : le bridge répond mais l'APS produit ~0 W pendant que ses
  //     panneaux JUMEAUX (SB1, mêmes 585 Wc, même pan Sud) chargent franchement —
  //     physiquement impossible. Un ciel couvert n'alerte pas (les jumeaux sont bas
  //     aussi) ; le bridage non plus (l'entrée SB1 n'y est plus significative).
  // C'est une ALERTE, pas un mode : le comportement du pilote ne change pas (la
  // dégradation naturelle vers la recharge HC est déjà la bonne réponse).
  const sb1InW = inputs.sbInputW[p.sb1BatteryIndex] ?? null;
  const batteriesFullNow =
    inputs.ankerAvailable &&
    socAvg !== null &&
    socAvg >= p.battFullPct &&
    inputs.batteryChargeW < p.chargeIdleW;
  const apsUnreachable =
    windowOpen &&
    (!inputs.apsAvailable || (inputs.apsAgeSec !== null && inputs.apsAgeSec > p.apsStaleSec));
  const apsSuspicious =
    windowOpen &&
    !apsUnreachable &&
    inputs.apsAvailable &&
    inputs.pvApsW <= p.apsMuteFloorW &&
    sb1InW !== null &&
    sb1InW >= p.apsTwinMinW &&
    !batteriesFullNow;
  if (apsSuspicious) {
    if (pilot.apsLowSinceTs === null) pilot.apsLowSinceTs = now;
  } else {
    pilot.apsLowSinceTs = null;
  }
  const apsFault =
    pilot.apsLowSinceTs !== null && now - pilot.apsLowSinceTs >= p.apsMuteConfirmSec * SEC;
  const apsAlert: PilotState['apsAlert'] = apsUnreachable
    ? 'unreachable'
    : apsFault
      ? 'fault'
      : 'none';
  if (apsAlert !== pilot.apsAlert) {
    events.push({
      ts: now,
      kind: 'phase',
      label: apsAlert === 'none' ? 'alerte APS levée' : 'alerte APS',
      detail:
        apsAlert === 'unreachable'
          ? 'panneaux APS injoignables (bridge muet ou données périmées) — détection solaire aveugle, repli recharge de nuit'
          : apsAlert === 'fault'
            ? `panne probable des panneaux APS : ${inputs.pvApsW} W alors que les jumeaux SB1 chargent ${sb1InW} W`
            : 'les panneaux APS répondent de nouveau'
    });
    pilot.apsAlert = apsAlert;
  }

  // ── Voie SATURATION/RÉSERVE (contexte Max AC zéro-export, 22/07/2026) ──
  // La Max AC régule le compteur à zéro-export (boucle ~3 s avec le Gen 2) : le
  // don franc a quasi disparu (mesuré : ZÉRO export soutenu > 150 W en régime
  // sain, amplitude écrêtée à ~80-160 W). Le surplus vit désormais dans SA
  // charge, lue en Modbus LOCAL (~2,5 s — classe « mesure locale » comme
  // l'EM-50, pas le cloud lent). Dès que la réserve nocturne est assurée
  // (SoC ≥ maxAcSocOnPct), le surplus mesuré (charge Max AC + don résiduel)
  // bascule vers le ballon : en allumant, la Max AC cesse simplement de charger
  // d'autant et le compteur reste à zéro. Budget de drain assumé :
  // heatPowerW − surplusOnW (~900 W), borné par les coupures (achat 150 W/30 s,
  // chute batteryDropCutPts, plancher batteryFloorCutPct) — inchangées.
  const surplusDispoW = (inputs.maxAcChargeW ?? 0) + exportW;
  const saturationTrigger =
    inputs.maxAcAvailable &&
    inputs.maxAcSocPct !== null &&
    inputs.maxAcSocPct >= p.maxAcSocOnPct &&
    inputs.em50Available &&
    buyW <= 50 &&
    surplusDispoW >= p.surplusOnW;

  // Déclencheur de secours — SURPLUS INVISIBLE (validé Laurent, question 2)
  const invisibleTrigger =
    inputs.ankerAvailable &&
    socAvg !== null &&
    socAvg >= p.battFullPct &&
    inputs.batteryChargeW < p.chargeIdleW &&
    inputs.em50Available &&
    buyW <= 50 &&
    exportW <= p.exportOnW && // ni achat, ni don franc : le surplus est invisible
    ctx.potential.invisibleSurplusW >= p.invisibleSurplusMinW;

  // État du bloc « déclencheur de secours » pour l'UI (voie ALTERNATIVE, jamais ✗ rouge)
  const rescue: PilotView['rescue'] =
    apsAlert !== 'none'
      ? { state: 'unavailable', detail: 'indisponible — APS muet' }
      : invisibleTrigger
        ? { state: 'armed', detail: 'ARMÉ — conditions bridage réunies' }
        : exportW > 50
          ? { state: 'standby_export', detail: 'en veille (don franc présent)' }
          : {
              state: 'standby_below',
              detail: `en veille — ${ctx.potential.invisibleSurplusW} W estimés / seuil ${p.invisibleSurplusMinW}`
            };

  // battFull a QUITTÉ le tronc commun (22/07) : chaque voie porte sa preuve —
  // l'export franc PROUVE que le parc n'absorbe plus (zéro-export Max AC), la
  // voie saturation exige la réserve locale, le secours invisible garde son
  // exigence « batteries pleines » en interne.
  const trigger = exportFrank || saturationTrigger || invisibleTrigger;
  const commonOk = tankNotFull && quietHouse && windowOk && quotaOk && delaysOk;
  const allOn = commonOk && trigger;

  // ── Chrono de persistance : les conditions doivent tenir observationBeforeOnSec ──
  if (allOn && !relayOn) {
    if (pilot.condsSinceTs === null) pilot.condsSinceTs = now;
  } else {
    pilot.condsSinceTs = null;
  }
  const armedForMs = pilot.condsSinceTs !== null ? now - pilot.condsSinceTs : 0;
  const solarStartReady =
    pilot.condsSinceTs !== null && armedForMs >= p.observationBeforeOnSec * SEC;

  // ═══ DÉCISION wantOn ═══
  let wantOn = false;
  let reason: PilotStepResult['reason'] = 'wait';
  let note = '';
  let cutCause: CessionCause | null = null;

  const isNightHc = ctx.minuteOfDay >= HC_START_MIN && ctx.minuteOfDay < HC_HARD_END_MIN;

  if (relayOn && heatingNow && isNightHc && pilot.hcPlan?.forDate === inputs.todayParis) {
    // ── Chauffe HC en cours : on achète EXPRÈS (tarif plancher) — pas de règle zéro achat ──
    if (hcTargetReached || ctx.minuteOfDay >= Math.min(HC_HARD_END_MIN, pilot.hcPlan.endMin)) {
      wantOn = false;
      reason = 'wait';
      note = hcTargetReached
        ? 'recharge de nuit : besoin atteint — on coupe (le soleil fera le reste)'
        : 'recharge de nuit : fin de fenêtre (07:30)';
    } else {
      wantOn = true;
      reason = 'hc';
      note = `recharge de nuit en cours — objectif ${Math.round((pilot.hcPlan.targetWh / 1000) * 10) / 10} kWh`;
    }
  } else if (relayOn && (heatingNow || inGrace)) {
    // ── Chauffe (solaire ou manuelle observée) : grâce puis règle zéro achat ──
    if (state.ballonCharged) {
      wantOn = false;
      note = 'le thermostat a coupé — ballon plein';
    } else if (inGrace) {
      wantOn = true;
      reason = 'solar';
      note = `allumage — régulation SolarBank en cours (${Math.round(onForMs / 60_000)} min de grâce)`;
      pilot.buyOverSinceTs = null; // pendant la grâce : AUCUN jugement
    } else {
      // Coupures, dans l'ordre de la spec. La sortie de grâce est jugée EN PREMIER :
      // un échec de grâce (nuage au départ) est de cause grace_fail — la reprise reste
      // soumise au quota (contrairement à une cession pour achat/électroménager).
      const justOutOfGrace = onForMs < (p.graceStartupSec + 75) * SEC;
      if (buyW > p.cutBuyW && justOutOfGrace) {
        cutCause = 'grace_fail';
        note = `fin de grâce : l'achat réseau persiste (${buyW} W) — on renonce`;
      } else if (buyW > p.cutBuyHardW) {
        cutCause = 'hard_buy';
        note = `achat franc ${buyW} W (> ${p.cutBuyHardW}) — la maison d'abord, coupure immédiate`;
      } else {
        if (buyW > p.cutBuyW) {
          if (pilot.buyOverSinceTs === null) pilot.buyOverSinceTs = now;
        } else {
          pilot.buyOverSinceTs = null;
        }
        if (
          pilot.buyOverSinceTs !== null &&
          now - pilot.buyOverSinceTs >= p.cutBuySustainSec * SEC
        ) {
          cutCause = 'buy';
          note = `achat réseau ${buyW} W soutenu ${p.cutBuySustainSec} s — la maison a besoin de sa puissance`;
        } else if (
          socAvg !== null &&
          pilot.socStartOfHeat !== null &&
          (socAvg <= pilot.socStartOfHeat - p.batteryDropCutPts || socAvg < p.batteryFloorCutPct)
        ) {
          cutCause = 'battery';
          note = `batteries ${Math.round(socAvg)} % (début ${Math.round(pilot.socStartOfHeat)} %) — réserve du soir protégée`;
        }
      }
      if (cutCause) {
        wantOn = false;
      } else {
        wantOn = true;
        reason = 'solar';
        note =
          note ||
          `chauffe au soleil — achat réseau ${buyW} W${exportW > 0 ? `, don ${exportW} W` : ''}`;
      }
    }
  } else if (hcWants) {
    // ── Démarrage de la recharge HC ──
    wantOn = true;
    reason = 'hc';
    note = `recharge de nuit — départ planifié ${minToHm(pilot.hcPlan!.startMin)}, fin ${p.hcEndTarget}`;
  } else if (solarStartReady) {
    // ── Allumage solaire : conditions tenues 3 min ──
    wantOn = true;
    reason = 'solar';
    note = exportFrank
      ? `allumage — don franc au réseau ${exportW} W depuis ${Math.round(armedForMs / 60_000)} min`
      : saturationTrigger
        ? `allumage — réserve faite (Max AC ${Math.round(inputs.maxAcSocPct ?? 0)} %), surplus réorienté ${surplusDispoW} W`
        : `allumage — surplus invisible estimé ${ctx.potential.invisibleSurplusW} W (batteries pleines)`;
  } else {
    wantOn = false;
    note = nextActionNote();
  }

  // ── Fronts : compteurs d'allumage + SoC de départ + journal ──
  const wasHeatingPiloted = relayOn && !state.ballonCharged;
  if (wantOn && reason === 'solar' && !relayOn) {
    // Front d'allumage solaire (réel en exploitation ; virtuel en observation)
    if (observation) {
      if (pilot.wouldOnSinceTs === null) {
        pilot.wouldOnSinceTs = now;
        countStart();
        events.push({
          ts: now,
          kind: 'phase',
          label: 'aurait allumé',
          detail: note
        });
      }
    } else {
      countStart();
      pilot.socStartOfHeat = socAvg;
      pilot.buyOverSinceTs = null;
      events.push({ ts: now, kind: 'phase', label: 'allumage', detail: note });
    }
  }
  if (!wantOn || reason !== 'solar') {
    if (!observation) pilot.wouldOnSinceTs = null;
  }
  if (observation && !allOn) pilot.wouldOnSinceTs = null;

  if (cutCause && wasHeatingPiloted) {
    pilot.lastCessionCause = cutCause;
    pilot.lastCessionTs = now;
    pilot.socStartOfHeat = null;
    pilot.buyOverSinceTs = null;
    events.push({
      ts: now,
      kind: 'phase',
      label: observation ? 'aurait coupé' : 'cession',
      detail: note
    });
  }
  // Début de chauffe réel détecté (exploitation OU manuel observé) : mémoriser le SoC
  if (relayOn && state.onSinceTs !== null && now - state.onSinceTs < 90 * SEC) {
    if (pilot.socStartOfHeat === null && socAvg !== null) pilot.socStartOfHeat = socAvg;
  }
  if (!relayOn && !observation) pilot.socStartOfHeat = null;

  function countStart(): void {
    if (pilot.lastCessionCause === 'buy' || pilot.lastCessionCause === 'hard_buy') {
      pilot.resumesToday += 1;
      pilot.lastCessionCause = null; // la reprise consomme le « ticket » hors quota
    } else {
      pilot.solarStartsToday += 1;
    }
  }

  // ── Phase dérivée (jamais désynchronisée du relais réel) ──
  let phase: PilotPhase;
  if (relayOn && heatingNow && isNightHc && pilot.hcPlan?.forDate === inputs.todayParis) {
    phase = 'recharge_hc';
  } else if (relayOn && inGrace) {
    phase = 'allumage';
  } else if (relayOn && heatingNow) {
    phase = 'chauffe';
  } else if (state.ballonCharged) {
    phase = 'plein';
  } else if (
    pilot.lastCessionTs !== null &&
    now - pilot.lastCessionTs < (config.minOffSec + config.antiCyclingSec) * SEC
  ) {
    phase = 'cession';
  } else {
    phase = 'repos';
  }
  const phaseSinceTs =
    phase === 'allumage' || phase === 'chauffe' || phase === 'recharge_hc'
      ? (state.onSinceTs ?? now)
      : phase === 'cession'
        ? (pilot.lastCessionTs ?? now)
        : (state.lastOffTs ?? state.lastTickTs ?? now);

  function nextActionNote(): string {
    if (pilot.hcPlan && pilot.hcPlan.forDate === ctx.tomorrowParis) {
      return `recharge de nuit planifiée ${minToHm(pilot.hcPlan.startMin)} → ${p.hcEndTarget}`;
    }
    if (
      pilot.hcPlan &&
      pilot.hcPlan.forDate === inputs.todayParis &&
      ctx.minuteOfDay < pilot.hcPlan.startMin
    ) {
      return `recharge de nuit à ${minToHm(pilot.hcPlan.startMin)}`;
    }
    if (!windowOpen) {
      if (sunWindowStart && sunWindow && ctx.minuteOfDay < sunWindow.startMin) {
        return `attente de la fenêtre solaire — ouverture prévue ${sunWindowStart}`;
      }
      if (sunWindowEnd && sunWindow && ctx.minuteOfDay >= sunWindow.endMin) {
        return `fenêtre solaire fermée pour aujourd'hui (rouverture demain vers ${sunWindowStart ?? '?'})`;
      }
      return 'attente de la fenêtre solaire (éphémérides)';
    }
    if (!inputs.em50Available) return 'compteur EM-50 muet — aucun allumage possible';
    if (!trigger) {
      if (!inputs.maxAcAvailable)
        return `attente d’un don franc au réseau (> ${p.exportOnW} W) — mesure locale muette`;
      return inputs.maxAcSocPct !== null && inputs.maxAcSocPct < p.maxAcSocOnPct
        ? `attente : la Max AC fait sa réserve (${Math.round(inputs.maxAcSocPct)} % / ${p.maxAcSocOnPct} %)`
        : `attente de surplus — charge Max AC + don ${surplusDispoW} W / ${p.surplusOnW} W`;
    }
    if (!quotaOk) return 'quota d’allumages du jour épuisé';
    if (!delaysOk) return 'délais de protection du matériel en cours';
    if (pilot.condsSinceTs !== null) {
      const left = Math.max(0, p.observationBeforeOnSec - armedForMs / SEC);
      return `conditions réunies — vérification encore ${Math.round(left)} s`;
    }
    return 'surveillance';
  }

  // ── Vue pour l'interface ──
  const view: PilotView = {
    phase,
    phaseSinceTs,
    wantOn,
    note,
    conds: [
      cond(
        'tank',
        'Ballon pas plein',
        tankNotFull,
        `${Math.round((ctx.eAvailWh / Math.max(1, ctx.eFullWh)) * 100)} % rempli`
      ),
      cond(
        'surplus',
        'Surplus disponible',
        exportFrank || (inputs.em50Available && buyW <= 50 && surplusDispoW >= p.surplusOnW),
        (inputs.maxAcAvailable
          ? `${surplusDispoW} W réorientables (charge Max AC ${Math.round(inputs.maxAcChargeW ?? 0)} W + don ${exportW} W)`
          : exportW > 0
            ? `${exportW} W donnés (mesure locale muette)`
            : '≈ 0 W') + (buyW > 50 ? ` · achat ${buyW} W` : '')
      ),
      cond(
        'reserve',
        'Réserve batterie',
        exportFrank ||
          (inputs.maxAcAvailable &&
            inputs.maxAcSocPct !== null &&
            inputs.maxAcSocPct >= p.maxAcSocOnPct),
        exportFrank
          ? 'prouvée par le don franc (le parc n’absorbe plus)'
          : inputs.maxAcAvailable && inputs.maxAcSocPct !== null
            ? `Max AC ${Math.round(inputs.maxAcSocPct)} % (seuil ${p.maxAcSocOnPct} %)`
            : 'mesure locale muette — voies don franc et secours seulement'
      ),
      cond(
        'quiet',
        'Maison tranquille',
        quietHouse,
        inputs.appliances
          .filter((a) => a.powerW !== null && a.powerW >= a.onW)
          .map((a) => a.name)
          .join(', ') || 'aucun gros appareil'
      ),
      cond(
        'window',
        'Fenêtre solaire',
        windowOk,
        windowOpen
          ? `${sunWindowStart ?? '?'} → ${sunWindowEnd ?? '?'} · soleil ${Math.round(sun.elevationDeg)}° · APS ${inputs.pvApsW} W · reste ${windowLeftMin} min`
          : sunWindowStart && sunWindowEnd
            ? `fermée · aujourd'hui ${sunWindowStart} → ${sunWindowEnd}`
            : 'fermée'
      ),
      cond(
        'quota',
        'Quota du jour',
        quotaOk,
        `${pilot.solarStartsToday}/${p.solarStartsPerDay} spontanés · ${pilot.resumesToday} reprises`
      ),
      cond('delays', 'Délais matériel', delaysOk, delaysOk ? 'écoulés' : 'purge en cours')
    ],
    rescue,
    apsAlert,
    sunWindowStart,
    sunWindowEnd,
    sunWindowNote,
    invisibleSurplusW: ctx.potential.invisibleSurplusW,
    potTotalW: ctx.potential.potTotalW,
    pApsW: Math.round(inputs.pvApsW),
    socNow: socAvg !== null ? Math.round(socAvg) : null,
    socStart: pilot.socStartOfHeat !== null ? Math.round(pilot.socStartOfHeat) : null,
    solarStartsToday: pilot.solarStartsToday,
    resumesToday: pilot.resumesToday,
    quota: p.solarStartsPerDay,
    nextAction: wantOn ? note : nextActionNote(),
    computedAt: now
  };

  return { wantOn, reason: wantOn ? reason : 'wait', view, events, pilot };
}

function cond(key: string, label: string, ok: boolean, detail: string): PilotView['conds'][number] {
  return { key, label, ok, detail };
}

/**
 * Plan de recharge HC : déficit pour 2 douches à 7 h 30 (pertes comprises), modulé
 * par la météo J+1 / J+2 (annotation Laurent : J+1 ensoleillé → strict besoin ;
 * J+1 ET J+2 gris → charger davantage). Départ calé pour FINIR à hcEndTarget.
 */
function computeHcPlan(
  forDate: string,
  inputs: CumulusInputs,
  config: CumulusConfig,
  ctx: PilotCtx,
  besoinStrictWh: number,
  now: number
): HcPlan | null {
  const p = config.pilot;
  const endTargetMin = hmToMin(p.hcEndTarget);

  // Modulation météo (forecastFaibleKwh = seuil « journée grise »)
  const grey = config.forecastFaibleKwh;
  const d1 = inputs.forecastD1Kwh;
  const d2 = inputs.forecastD2Kwh;
  let factor = 1;
  let why = 'demain s’annonce ensoleillé — strict besoin douches';
  if (d1 >= 0 && d1 < grey) {
    if (d2 >= 0 && d2 < grey) {
      factor = p.hcGrey2Factor;
      why = `deux jours gris annoncés (${d1.toFixed(1)} / ${d2.toFixed(1)} kWh) — on charge davantage`;
    } else {
      factor = p.hcGrey1Factor;
      why = `demain gris (${d1.toFixed(1)} kWh) — marge ajoutée`;
    }
  } else if (d1 < 0) {
    why = 'prévision indisponible — strict besoin douches';
  }
  const targetWh = Math.min(ctx.eFullWh * p.fullFraction, Math.round(besoinStrictWh * factor));

  // Pertes d'ici la fin de chauffe (heures de maintenant → hcEndTarget, lendemain si le
  // calcul se fait le soir)
  const nowMin = ctx.minuteOfDay;
  const minutesUntilEnd =
    nowMin < endTargetMin ? endTargetMin - nowMin : 24 * 60 - nowMin + endTargetMin;
  const lossWh = ctx.lossPerHWh * (minutesUntilEnd / 60);

  const deficitWh = Math.max(0, targetWh + lossWh - ctx.eAvailWh);
  const heatWhPerH = p.heatPowerW * config.energyModel.etaHeat;
  const durationMin = (deficitWh / heatWhPerH) * 60;
  if (durationMin < 5) return null; // rien à recharger

  const startMin = Math.max(HC_START_MIN, Math.round(endTargetMin - durationMin));
  return {
    forDate,
    targetWh,
    minWh: besoinStrictWh,
    startMin,
    endMin: HC_HARD_END_MIN,
    reason: why,
    computedAt: now
  };
}
