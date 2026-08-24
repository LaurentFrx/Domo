/**
 * Orchestrateur cumulus — boucle impure `tick()` (V2, 03/07/2026).
 *
 * Ordre du tick (leçon V1 : les décisions instantanées agissent sur les mesures
 * FRAÎCHES du tick, seule la jauge d'eau — lente — vient du tick précédent) :
 *   collecte des entrées → estimateur de potentiel solaire → PILOTE (machine à
 *   phases) → decide() (protections + overrides) → application relais (watchdog
 *   toggle_after) → calorimétrie (energy-model, INCHANGÉ) → journal → persistance.
 *
 * Garde-fous : mutex anti-concurrence, timeout global, idempotence des ordres,
 * dry-run. En OBSERVATION (observationMode=true) : le pilote calcule et journalise
 * chaque décision qu'il AURAIT prise, decide() n'émet AUCUN ordre automatique.
 */

import { decide, type PilotWant } from './decide';
import { feedforwardCumulusStep } from '../sb3loop/engine';
import { collectInputs } from './inputs';
import { readCumulusConfig } from './config';
import { readCumulusState, writeCumulusState } from './state-store';
import { setRelay } from './relay';
import { ensureTempSensor } from './temp-sensor';
import { updateEnergyModel, type EnergyTickResult } from './energy-model';
import { pilotStep, type PilotCtx } from './pilot';
import {
  estimatePotential,
  readSolarCalib,
  writeSolarCalib,
  type SolarCalib
} from './solar-potential';
import {
  readProbeRelaxCalib,
  writeProbeRelaxCalib,
  type ProbeRelaxCalib
} from './probe-relax-calib';
import { parisDate } from '../tariffs';
import { sendPush } from '../monitor/push';
import type { AutoMode, CriterionSample, DecisionLogEntry, ShadowEvent } from './types';

const TICK_TIMEOUT_MS = 45_000; // < intervalle timer (60 s)
// Budget d'attente du PRÉ-ARMEMENT SB3 avant fermeture du relais : au-delà, on
// ferme quand même (repli = comportement d'avant) et l'écriture, si elle
// aboutit en retard, atterrit juste après la fermeture — encore utile.
const PREARM_BUDGET_MS = 22_000;
const SHADOW_HEAT_W = 500; // conso EM-50 voie cumulus au-dessus → « en chauffe » (timeline)
const SHADOW_LOG_MAX = 80; // taille du journal (timeline du jour)
const CRITERION_LOG_MAX = 660; // journal du labo du critère énergie (~12 h à 65 s/tick)
const APPLIANCE_OFF_GRACE_MS = 10 * 60_000; // sous le seuil > 10 min → cycle terminé
const LOG_MAX = 60;

// ── Filet de sécurité « RÈGLE ZÉRO IMPORT » (le ballon ne doit JAMAIS soutirer d'EDF) ──
// Le pilote V2 coupe déjà sur import (≈150 W / 30 s) ; cette sonde n'alerte que s'il a
// ÉCHOUÉ à protéger, en tolérant l'import transitoire de démarrage (latence SolarBank 2-3 min).
const IMPORT_HEAT_MIN_W = 100; // conso ballon au-dessus → chauffe réelle en cours
const IMPORT_GRID_MIN_W = 150; // soutirage EDF (gridPowerW > 0 = import) au-dessus → import franc
const IMPORT_GRACE_MS = 4 * 60_000; // import soutenu au-delà → le pilote aurait dû couper → ALERTE

// Heure locale Paris fractionnaire (0–24) + mois (1-12).
const PARIS_HM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const PARIS_MONTH = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  month: 'numeric'
});
function parisHourFrac(ts: number): number {
  const parts = PARIS_HM.format(new Date(ts)).split(':');
  return Number(parts[0]) + Number(parts[1]) / 60;
}

export interface TickResult {
  skipped?: 'busy';
  applied: boolean;
  apply: boolean;
  relayDesired: boolean;
  relayOn: boolean | null;
  reason: string;
  anomaly: string;
  surplusW: number;
  note: string;
  observationMode?: boolean;
  anker?: {
    available: boolean;
    pvPowerW: number;
    sbOutputPowerW: number;
    batteryDischargeW: number;
    socPct: number[];
  };
  energy?: EnergyTickResult;
}

let ticking = false;
// Calibration de l'estimateur solaire : cache mémoire, chargée au premier tick,
// persistée quand elle évolue (data/solar-potential.json — données apprises).
let solarCalib: SolarCalib | null = null;
// Calibration de la relaxation post-plein de la sonde (04/07) — même mécanique que
// solarCalib : cache mémoire, chargée au premier tick, persistée quand elle évolue.
let probeRelaxCalib: ProbeRelaxCalib | null = null;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('tick timeout')), ms))
  ]);
}

/** N'empile au journal que les changements (raison / ordre / anomalie) — pas de bruit. */
function appendLog(log: DecisionLogEntry[], e: DecisionLogEntry): DecisionLogEntry[] {
  const last = log[log.length - 1];
  const changed =
    !last ||
    last.reason !== e.reason ||
    last.relayDesired !== e.relayDesired ||
    last.anomaly !== e.anomaly;
  if (!changed) return log;
  return [...log, e].slice(-LOG_MAX);
}

async function runTick(apply: boolean): Promise<TickResult> {
  ensureTempSensor();
  const config = await readCumulusConfig();
  const state = await readCumulusState();
  const inputs = await collectInputs(config);
  const now = inputs.now;

  // ── 1. Estimateur de potentiel solaire (APS = étalon ; calibration EWMA persistée) ──
  if (solarCalib === null) solarCalib = await readSolarCalib();
  if (probeRelaxCalib === null) probeRelaxCalib = await readProbeRelaxCalib();
  const socs = inputs.batterySocPct.filter((s) => Number.isFinite(s));
  const socAvg = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null;
  const batteriesFull =
    inputs.ankerAvailable &&
    socAvg !== null &&
    socAvg >= config.pilot.battFullPct &&
    inputs.batteryChargeW < config.pilot.chargeIdleW;
  const sb1Idx = config.pilot.sb1BatteryIndex;
  const potential = estimatePotential(
    {
      ts: now,
      monthLocal: Number(PARIS_MONTH.format(new Date(now))),
      hourLocal: Math.floor(parisHourFrac(now)),
      pApsW: Math.max(0, inputs.pvApsW),
      sb1InW: inputs.sbInputW[sb1Idx] ?? null,
      sb2InW: inputs.sbInputW[1 - sb1Idx] ?? null,
      pvShownW: Math.max(0, inputs.pvPowerW),
      batteriesFull
    },
    config.pilot.latDeg,
    config.pilot.lonDeg,
    solarCalib
  );
  if (potential.calibUpdated) {
    // Persistance des données apprises (throttle naturel : ~1 écriture/min max en journée)
    await writeSolarCalib(solarCalib).catch(() => {});
  }

  // ── 2. PILOTE (machine à phases) — sur les mesures FRAÎCHES ; jauge du tick précédent ──
  const hourLocal = parisHourFrac(now);
  const ctx: PilotCtx = {
    eAvailWh: state.energyView?.eAvailWh ?? 0,
    eFullWh: state.energyView?.eFullWh ?? 0,
    eDoucheWh: state.energyView?.eDoucheWh ?? config.energyModel.eDoucheWhSummer,
    lossPerHWh: state.energyView?.lossPerHWh ?? 0,
    hourLocal,
    minuteOfDay: Math.round(hourLocal * 60),
    tomorrowParis: parisDate(new Date(now + 86_400_000)),
    potential
  };
  const pilotRes = pilotStep(inputs, config, state, ctx);

  const pilotWant: PilotWant = {
    wantOn: pilotRes.wantOn,
    reason: pilotRes.reason === 'wait' ? 'wait' : pilotRes.reason,
    note: pilotRes.view.note,
    cutCause: pilotRes.cutCause
  };

  // ── 3. Décision (protections + overrides par-dessus le pilote) ──
  const decision = decide(inputs, config, state, pilotWant);
  const next = decision.nextState;
  next.pilot = pilotRes.pilot;
  next.pilotView = pilotRes.view;
  // ── LABO : journal du critère énergie (n'influence RIEN) ──
  // Un point par tick : le bilan du critère, le verdict des voies historiques,
  // la CAUSE réelle de la décision (decide) et le réseau. C'est CE journal qui
  // décidera du retrait des vieux seuils (étape 7 de la spec) — il a remplacé
  // le shadow de désirabilité (NO-GO à l'audit d'août, supprimé le 24/08).
  // Assemblé APRÈS decide() : la cause distingue une chauffe pilot_solar (qui
  // JUGE le critère) d'une recharge HC ou d'un boost (qui achètent légitimement).
  const criterionSample: CriterionSample = {
    ts: now,
    uParcWh: pilotRes.energy.uParcWh,
    eChauffeWh: pilotRes.energy.eChauffeWh,
    reserveWh: pilotRes.reserve.wh,
    besoinWh: pilotRes.energy.besoinWh,
    energyOk: pilotRes.energy.trigger,
    legacyOk: pilotRes.energy.legacyTrigger,
    commonOk: pilotRes.energy.commonOk,
    windowOpen: pilotRes.energy.windowOpen,
    wantOn: pilotRes.wantOn,
    relayOn: inputs.relayOn === true,
    heating: inputs.em50Available && inputs.cumulusPowerW > SHADOW_HEAT_W,
    cause: decision.reason,
    gridW: Math.round(inputs.gridPowerW)
  };
  next.criterionLog = [...state.criterionLog, criterionSample].slice(-CRITERION_LOG_MAX);

  let relayOn = inputs.relayOn;
  let applied = false;

  if (apply && decision.apply && inputs.relayAvailable) {
    const desired = decision.relayDesired;
    const needChange = relayOn !== desired;
    const needRearm = desired === true; // ré-armer le watchdog Shelly tant qu'on veut ON
    if (needChange || needRearm) {
      // ── FEEDFORWARD SB3 (étude §8 + banc du 31/07) : l'échelon du cumulus est
      // le SEUL échelon prévisible — c'est nous qui choisissons l'instant. ──
      if (needChange && desired) {
        // PRÉ-ARMEMENT : monter la part SB3 AVANT de fermer le relais, pour que
        // la Max AC n'ait pas à monter seule en butée pendant que les SB3
        // attendent le cloud (~30-60 s d'achat EDF sinon). Attente BORNÉE :
        // budget dépassé ⇒ on ferme quand même, l'écriture suit et aide encore.
        const note = await Promise.race([
          feedforwardCumulusStep(config.pilot.heatPowerW).then((r) => r.note),
          new Promise<string>((resolve) => {
            const t = setTimeout(
              () =>
                resolve(`budget ${PREARM_BUDGET_MS / 1000} s dépassé — fermeture sans attendre`),
              PREARM_BUDGET_MS
            );
            t.unref?.(); // jamais retenir l'arrêt du service (leçon SIGTERM)
          })
        ]);
        console.log(`[cumulus] pré-armement SB3 : ${note}`);
      }
      const res = await setRelay(desired, desired ? config.autoOffDelaySec : undefined);
      if (res.ok) {
        applied = needChange;
        if (res.on !== null) relayOn = res.on;
        if (res.on !== null && res.on !== desired) next.anomaly = 'desync';
        // DÉSARMEMENT : à l'ouverture, rendre la part SB3 de la puissance
        // MESURÉE du ballon (EM-50 voie 1) — sinon la descente progressive
        // laisse les SB3 sur-livrer plusieurs minutes (recyclage vers la
        // Max AC + injection quand elle n'absorbe pas). L'ouverture, elle, ne
        // se diffère JAMAIS : l'écriture part en arrière-plan, après coup.
        if (needChange && !desired && inputs.cumulusPowerW > SHADOW_HEAT_W) {
          void feedforwardCumulusStep(-inputs.cumulusPowerW).then((r) =>
            console.log(`[cumulus] désarmement SB3 : ${r.note}`)
          );
        }
      } else {
        next.anomaly = 'relay_unreachable';
      }
    }
  } else if (!apply) {
    next.lastOnTs = state.lastOnTs;
    next.lastOffTs = state.lastOffTs;
    next.lastTransitionTs = state.lastTransitionTs;
    next.relayDesired = state.relayDesired;
  }

  // ── Notification push : transition RÉELLE du relais cumulus (allumage / extinction) ──
  // Basée sur l'état observé du Shelly (`relayOn`), quel que soit le déclencheur
  // (manuel, boost, pilote, watchdog auto-off, ou coupure physique). On ne notifie
  // qu'entre deux états booléens connus — jamais depuis/vers null (relais injoignable)
  // — et une seule fois par transition (référence `lastRelayNotifiedOn` persistée).
  if (typeof relayOn === 'boolean') {
    const prevNotified = state.lastRelayNotifiedOn;
    if (typeof prevNotified === 'boolean' && prevNotified !== relayOn) {
      const eau = inputs.tempC !== null ? `${inputs.tempC} °C` : 'temp. inconnue';
      const modeLbl = config.observationMode
        ? ' · observation'
        : state.autoMode === 'manual'
          ? ' · manuel'
          : state.autoMode === 'off'
            ? ' · coupé'
            : ' · auto';
      // Fire-and-forget : sendPush ne throw jamais (erreurs gérées en interne) ; on
      // n'attend pas pour ne pas ajouter de latence au tick de pilotage.
      void sendPush({
        title: relayOn ? '🔴 Cumulus allumé' : '⚪️ Cumulus éteint',
        body: relayOn
          ? `Chauffe en cours — eau ${eau}${modeLbl}`
          : `Chauffe arrêtée — eau ${eau}${modeLbl}`,
        tag: 'cumulus-relay',
        severity: 'info',
        url: '/energie'
      });
    }
    next.lastRelayNotifiedOn = relayOn;
  } else {
    // relais injoignable ce tick : on conserve la dernière référence connue
    next.lastRelayNotifiedOn = state.lastRelayNotifiedOn;
  }

  // ── Filet « zéro import » : import EDF soutenu PENDANT une chauffe réelle ──
  // gridPowerW > 0 = soutirage EDF ; ballon en chauffe = relais ON + conso franche.
  // Si la condition tient au-delà de la grâce (le pilote aurait dû couper), on ALERTE
  // une seule fois par épisode (reset dès que la condition tombe).
  {
    const heatingReal = relayOn === true && inputs.cumulusPowerW > IMPORT_HEAT_MIN_W;
    const importingNow = inputs.gridPowerW > IMPORT_GRID_MIN_W;
    let impSince = state.importDuringHeatSinceTs;
    let impAlerted = state.importAlerted;
    if (heatingReal && importingNow) {
      if (impSince === null) impSince = now;
      const durMs = now - impSince;
      if (durMs >= IMPORT_GRACE_MS && !impAlerted) {
        impAlerted = true;
        const w = Math.round(inputs.gridPowerW);
        const mins = Math.round(durMs / 60_000);
        console.warn(
          `[cumulus] ALERTE zéro-import : ${w} W soutirés à l'EDF pendant la chauffe depuis ${mins} min — le pilote n'a pas coupé`
        );
        void sendPush({
          title: '⚠️ Le cumulus soutire de l’EDF',
          body: `Import ${w} W pendant la chauffe depuis ${mins} min — le pilote n’a pas coupé. Coupe le ballon si besoin.`,
          tag: 'cumulus-import',
          severity: 'critical',
          url: '/energie'
        });
      }
    } else {
      // conditions levées (import retombé ou chauffe finie) → fin de l'épisode
      impSince = null;
      impAlerted = false;
    }
    next.importDuringHeatSinceTs = impSince;
    next.importAlerted = impAlerted;
  }

  // Journal console — visible dans `journalctl -u domo`.
  console.log(
    `[cumulus] ${decision.reason} relais=${relayOn ? 'ON' : 'off'}` +
      `${config.observationMode ? ' [OBSERVATION]' : ''}` +
      ` eau=${inputs.tempC ?? '?'}°C |` +
      ` EDF=${Math.round(inputs.gridPowerW)}W ballon=${Math.round(inputs.cumulusPowerW)}W` +
      ` soc=[${inputs.batterySocPct.join('/')}]% — ${decision.note}`
  );
  console.log(
    `[pilot] phase=${pilotRes.view.phase} wantOn=${pilotRes.wantOn ? 'OUI' : 'non'}` +
      ` | APS=${pilotRes.view.pApsW}W potentiel=${pilotRes.view.potTotalW}W` +
      ` surplus_invisible=${pilotRes.view.invisibleSurplusW}W` +
      ` | allumages ${pilotRes.view.solarStartsToday}/${pilotRes.view.quota} (+${pilotRes.view.resumesToday} reprises)` +
      ` | parc=${pilotRes.energy.uParcWh ?? '—'}Wh besoin=${pilotRes.energy.besoinWh ?? '—'}Wh` +
      ` (chauffe ${pilotRes.energy.eChauffeWh ?? '—'} + soir ${pilotRes.reserve.wh ?? '—'} + tampon 1500)` +
      `${pilotRes.energy.trigger ? ' ✓ÉNERGIE' : ''}` +
      ` | ${pilotRes.view.nextAction}`
  );

  // ── 4. Calorimétrie du ballon (energy-model — bilan/anchor INCHANGÉS ; détection
  //    de puisage complétée du terme de relaxation post-plein, 04/07) ──
  const energyTick = updateEnergyModel(inputs, config, next, probeRelaxCalib);
  next.energy = energyTick.energy;
  const er = energyTick.result;
  if (er.relaxAbsorbedC !== null) {
    console.log(
      `[energy] relaxation post-plein absorbée : ${er.relaxAbsorbedC}°C (amplitude=${er.relaxAmplitudeC}°C tau=${er.relaxTauMin}min) — pas de puisage retenu`
    );
  }
  if (energyTick.calibUpdated) {
    await writeProbeRelaxCalib(probeRelaxCalib).catch(() => {});
  }
  // Instantané pour l'UI ET pour la jauge du pilote au tick suivant.
  next.energyView = {
    eAvailWh: er.eAvailWh,
    eFullWh: er.eFullWh,
    showers: +er.showers.toFixed(2),
    tTankC: er.tTankC,
    eDoucheWh: er.eDoucheWh,
    lossPerHWh: +(config.energyModel.lossCoeffWhPerCh * Math.max(0, er.tTankC - er.tRoomC)).toFixed(
      1
    ),
    relaxAmplitudeC: er.relaxAmplitudeC,
    relaxTauMin: er.relaxTauMin
  };

  // ── 5. Boucle de REGRET : ventilation MESURÉE de chaque chauffe (EM50 + Anker) ──
  {
    const emptyDay = (date: string) => ({
      date,
      injWh: 0,
      pvWh: 0,
      battWh: 0,
      gridHpWh: 0,
      gridHcWh: 0,
      costRealEur: 0,
      costRefHcEur: 0,
      gainEur: 0
    });
    let reg = next.regret ?? { day: emptyDay(inputs.todayParis), days: [] };
    if (reg.day.date !== inputs.todayParis) {
      const days = reg.day.injWh > 0 ? [...reg.days, reg.day].slice(-30) : reg.days;
      reg = { day: emptyDay(inputs.todayParis), days };
    } else {
      reg = { day: { ...reg.day }, days: reg.days };
    }
    const heating = inputs.em50Available && inputs.cumulusPowerW > SHADOW_HEAT_W;
    if (heating) {
      const dtH = Math.min(0.1, Math.max(0, (now - (state.lastTickTs ?? now)) / 3_600_000));
      const base = inputs.cumulusPowerW;
      const gridDraw = Math.max(0, Math.min(base, inputs.gridPowerW));
      const battCover = Math.max(0, Math.min(inputs.batteryDischargeW, base - gridDraw));
      const pvCover = Math.max(0, base - gridDraw - battCover);
      reg.day.pvWh += pvCover * dtH;
      reg.day.battWh += battCover * dtH;
      if (inputs.isHC) reg.day.gridHcWh += gridDraw * dtH;
      else reg.day.gridHpWh += gridDraw * dtH;
    }
    reg.day.injWh = Math.round(reg.day.pvWh + reg.day.battWh + reg.day.gridHpWh + reg.day.gridHcWh);
    reg.day.costRealEur = +(
      (reg.day.gridHpWh / 1000) * inputs.priceHp +
      (reg.day.gridHcWh / 1000) * inputs.priceHc
    ).toFixed(3);
    reg.day.costRefHcEur = +((reg.day.injWh / 1000) * inputs.priceHc).toFixed(3);
    reg.day.gainEur = +(reg.day.costRefHcEur - reg.day.costRealEur).toFixed(3);
    next.regret = reg;
  }

  // ── 6. Timeline (journal du jour : phases du pilote / chauffes / puisages / appareils) ──
  {
    const evs: ShadowEvent[] = [...pilotRes.events];
    const heatingNow = inputs.em50Available && inputs.cumulusPowerW > SHADOW_HEAT_W;
    if (heatingNow && state.shadowHeat === null) {
      const solar = inputs.gridPowerW < SHADOW_HEAT_W;
      next.shadowHeat = { sinceTs: now, sinceInjWh: er.injWhDay, solar };
      evs.push({
        ts: now,
        kind: 'heat_start',
        label: 'chauffe',
        detail: solar ? 'soleil' : 'réseau'
      });
    } else if (!heatingNow && state.shadowHeat !== null) {
      const durMin = Math.round((now - state.shadowHeat.sinceTs) / 60_000);
      const kwh = ((er.injWhDay - state.shadowHeat.sinceInjWh) / 1000).toFixed(2);
      evs.push({
        ts: now,
        kind: 'heat_end',
        label: 'chauffe finie',
        detail: `${durMin} min · ${kwh} kWh · ${state.shadowHeat.solar ? 'gratuit (soleil)' : 'réseau'}`
      });
      next.shadowHeat = null;
    }
    if (er.drawEvent) {
      evs.push({
        ts: now,
        kind: 'draw',
        label: 'puisage',
        detail: `−${er.drawEvent.eDrawnWh} Wh (${er.drawEvent.dropC}°C)`
      });
    }
    if (er.anchored && next.energy.lastAnchorTs !== state.energy.lastAnchorTs) {
      evs.push({ ts: now, kind: 'full', label: 'ballon plein', detail: 'recalage E_avail' });
    }

    // Cycles des gros appareils (lave-vaisselle / lave-linge) : nommer la conso +
    // l'interaction avec le pilote (une cession « achat réseau » pendant le cycle).
    {
      const dtH = Math.min(0.1, Math.max(0, (now - (state.lastTickTs ?? now)) / 3_600_000));
      const cededForBuy =
        next.pilot.lastCessionTs !== null &&
        now - next.pilot.lastCessionTs < 10 * 60_000 &&
        (next.pilot.lastCessionCause === 'buy' || next.pilot.lastCessionCause === 'hard_buy');

      const nextCycles: Record<string, (typeof state.applianceCycles)[string]> = {};
      for (const ap of inputs.appliances) {
        let cyc = state.applianceCycles[ap.topic] ? { ...state.applianceCycles[ap.topic] } : null;
        const fresh = ap.powerW !== null;
        const pw = ap.powerW ?? 0;

        if (fresh && pw >= ap.onW) {
          if (!cyc || !cyc.running) {
            cyc = {
              running: true,
              startTs: now,
              startEnergyKwh: ap.energyKwh,
              energyWh: 0,
              peakW: pw,
              lastAboveTs: now,
              coHeatTicks: 0,
              deferTicks: 0
            };
          } else {
            cyc.lastAboveTs = now;
            cyc.peakW = Math.max(cyc.peakW, pw);
          }
        }

        if (cyc && cyc.running) {
          if (fresh) cyc.energyWh += pw * dtH;
          if (heatingNow) cyc.coHeatTicks++;
          else if (cededForBuy) cyc.deferTicks++;

          if (now - cyc.lastAboveTs > APPLIANCE_OFF_GRACE_MS) {
            const endKwh =
              cyc.startEnergyKwh !== null &&
              ap.energyKwh !== null &&
              ap.energyKwh >= cyc.startEnergyKwh
                ? ap.energyKwh - cyc.startEnergyKwh
                : cyc.energyWh / 1000;
            const durMin = Math.max(1, Math.round((cyc.lastAboveTs - cyc.startTs) / 60_000));
            const note =
              cyc.deferTicks > 0
                ? 'le chauffe-eau a cédé la place (la maison d’abord)'
                : cyc.coHeatTicks > 0
                  ? 'le chauffe-eau a chauffé en même temps (couvert par le solaire)'
                  : 'sans effet sur le chauffe-eau';
            evs.push({
              ts: cyc.lastAboveTs,
              kind: 'appliance',
              label: ap.name,
              detail: `${endKwh.toFixed(2).replace('.', ',')} kWh · ${durMin} min · ${note}`
            });
            cyc.running = false;
          }
        }

        if (cyc && cyc.running) nextCycles[ap.topic] = cyc;
      }
      next.applianceCycles = nextCycles;
    }

    if (evs.length) next.shadowLog = [...state.shadowLog, ...evs].slice(-SHADOW_LOG_MAX);
  }

  const fmtSrc = (s: { name: string; tempC: number }[]) =>
    s.length ? s.map((x) => `${x.name} ${x.tempC}`).join(' + ') : 'repli';
  console.log(
    `[energy] E_avail=${er.eAvailWh} Wh (~${er.showers.toFixed(1)} douches)` +
      ` inj=${Math.round(er.injWhDay)} loss=${Math.round(er.lossWhDay)} draw=${Math.round(er.drawWhDay)} |` +
      ` T_tank≈${er.tTankC}°C T_inlet=${er.tInletC}°C |` +
      ` T_room=${inputs.indoorC ?? '?'}°C (${fmtSrc(inputs.indoorSources)})` +
      ` ext=${inputs.outdoorC ?? '?'}°C (${fmtSrc(inputs.outdoorSources)}) |` +
      ` dernier plein ${er.hoursSinceAnchor === null ? 'jamais' : er.hoursSinceAnchor.toFixed(1) + 'h'}` +
      `${er.anchored ? ' [ANCHOR→plein]' : ''}` +
      `${er.drawEvent ? ` [PUISAGE drop=${er.drawEvent.dropC}°C −${er.drawEvent.eDrawnWh}Wh]` : ''}`
  );

  next.lastTickTs = now;
  next.log = appendLog(state.log, {
    ts: now,
    reason: decision.reason,
    relayDesired: decision.relayDesired,
    tempC: inputs.tempC,
    surplusW: decision.surplusW,
    cumulusPowerW: inputs.cumulusPowerW,
    isHC: inputs.isHC,
    anomaly: next.anomaly
  });

  await writeCumulusState(next);

  return {
    applied,
    apply: decision.apply,
    relayDesired: decision.relayDesired,
    relayOn,
    reason: decision.reason,
    anomaly: next.anomaly,
    surplusW: decision.surplusW,
    note: decision.note,
    observationMode: config.observationMode,
    anker: {
      available: inputs.ankerAvailable,
      pvPowerW: inputs.pvPowerW,
      sbOutputPowerW: inputs.sbOutputPowerW,
      batteryDischargeW: inputs.batteryDischargeW,
      socPct: inputs.batterySocPct
    },
    energy: er
  };
}

/**
 * Un tick du moteur. `apply=false` = dry-run (calcule sans toucher au relais).
 * Retourne `skipped:'busy'` si un tick est déjà en cours (pas de concurrence).
 */
export async function tick(apply = true): Promise<TickResult> {
  if (ticking) {
    return {
      skipped: 'busy',
      applied: false,
      apply: false,
      relayDesired: false,
      relayOn: null,
      reason: 'busy',
      anomaly: 'none',
      surplusW: 0,
      note: 'tick déjà en cours'
    };
  }
  ticking = true;
  try {
    return await withTimeout(runTick(apply), TICK_TIMEOUT_MS);
  } finally {
    ticking = false;
  }
}

/**
 * Applique une commande utilisateur (mode auto/manuel/vacances, forçage relais)
 * puis déclenche un tick immédiat pour refléter le changement sans attendre 60 s.
 */
export async function applyCommand(cmd: {
  autoMode?: AutoMode;
  manualRelayOn?: boolean;
  boost?: boolean;
}): Promise<TickResult> {
  const state = await readCumulusState();
  if (cmd.autoMode) {
    state.autoMode = cmd.autoMode;
    if (cmd.autoMode === 'auto') state.boostUntilFull = false;
  }
  if (typeof cmd.manualRelayOn === 'boolean') {
    state.manualRelayOn = cmd.manualRelayOn;
    if (state.autoMode !== 'off') state.autoMode = 'manual';
  }
  if (typeof cmd.boost === 'boolean') {
    state.boostUntilFull = cmd.boost;
    if (cmd.boost) state.autoMode = 'auto';
  }
  await writeCumulusState(state);
  return tick(true);
}
