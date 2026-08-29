/**
 * Loi de commande du bridage APS — fonction PURE (testable sans réseau).
 *
 * Objectif : réseau ≥ 0 (aucune injection) en produisant le MAXIMUM possible.
 *
 * Principe. Quand le compteur mesure une injection, c'est que plus rien n'absorbe :
 * la Max AC régule déjà à zéro et aurait encaissé si elle l'avait pu. L'excédent est
 * donc réellement perdu, et il vient de la production non régulée — l'APS. On abaisse
 * alors son plafond de l'excédent MESURÉ (pas d'un forfait), puis on le remonte par
 * paliers dès que le réseau redevient propre : une recherche continue du plafond
 * maximal sans injection.
 *
 * Hiérarchie (ordre d'évaluation strict) :
 *   1. compteur muet  → plafond MAX. On ne bride jamais sur une mesure absente.
 *   2. onduleur muet (nuit) → plafond MAX, pour que demain matin ne soit pas bridé.
 *   3. soutirage EDF  → plafond MAX. Priorité absolue : ne jamais brider pendant
 *      un import, ce serait payer du courant pour brider du solaire gratuit.
 *   4. injection PERSISTANTE → abaisser.
 *   5. réseau propre  → remonter par paliers.
 *
 * Asymétrie assumée : on bride vite (après exportSustainSec), on remonte lentement
 * (raiseStepW toutes les raiseDwellSec). Injecter est ce qu'on doit éviter ; perdre
 * un peu de production quelques minutes coûte beaucoup moins cher qu'un cycle
 * d'oscillation. Séparation des échelles : la Max AC régule en secondes, nous en
 * minutes — les deux régulateurs ne se disputent pas la même variable.
 */
import type { ApsDecision, ApsLoopConfig, ApsLoopInputs, ApsLoopState } from './types';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function decideAps(
  inputs: ApsLoopInputs,
  cfg: ApsLoopConfig,
  state: ApsLoopState
): ApsDecision {
  const st: ApsLoopState = { ...state };
  const lo = inputs.apsMinLimitW;
  const hi = inputs.apsMaxLimitW;
  const cur = clamp(inputs.apsMaxW, lo, hi);

  /** Applique bande morte + temporisation ; rend la décision finale. */
  const apply = (raw: number, mode: ApsDecision['mode'], reason: string): ApsDecision => {
    const targetW = clamp(Math.round(raw), lo, hi);
    const sinceWrite = st.lastWriteTs === null ? Infinity : (inputs.now - st.lastWriteTs) / 1000;
    if (Math.abs(targetW - cur) < cfg.deadbandW)
      return {
        mode: 'hold',
        writeW: null,
        targetW,
        reason: `${reason} — dans la bande morte`,
        nextState: st
      };
    if (sinceWrite < cfg.dwellSec)
      return {
        mode: 'hold',
        writeW: null,
        targetW,
        reason: `${reason} — temporisation`,
        nextState: st
      };
    st.lastWriteTs = inputs.now;
    st.lastCmdW = targetW;
    return { mode, writeW: targetW, targetW, reason, nextState: st };
  };

  // ── 1. Compteur muet : on ne bride JAMAIS sans savoir ce que fait le réseau. ──
  if (!inputs.em50Available) {
    st.exportSinceTs = null;
    return apply(hi, 'failsafe', 'compteur EM-50 muet — plafond rendu au maximum');
  }

  // ── 2. Onduleur endormi (nuit) : RIEN À ÉCRIRE. ──
  // Ce cas rendait le plafond au maximum — c'est-à-dire qu'il ENVOYAIT une
  // consigne à un appareil éteint. Le pont ne pouvait pas la confirmer, deux
  // ticks suffisaient à faire compter deux échecs, et la protection se coupait
  // elle-même (12/08/2026 21h23, puis 17 jours d'injection non bridée).
  // Ne rien écrire est aussi le comportement SÛR : le plafond est un bail de
  // 600 s côté pont, il retombe de lui-même au maximum si personne ne le
  // réaffirme — l'onduleur retrouve donc sa pleine puissance au réveil, sans
  // qu'on ait à le lui dire. Et il n'y a rien à brider sur un onduleur à 0 W.
  if (!inputs.apsAvailable) {
    st.exportSinceTs = null;
    return {
      mode: 'night',
      writeW: null,
      targetW: hi,
      reason: 'onduleur endormi — rien à écrire (le bail rend le plafond au maximum)',
      nextState: st
    };
  }

  const exportW = Math.max(0, -inputs.gridW);
  const importW = Math.max(0, inputs.gridW);

  // ── 3. Soutirage : la maison a besoin de tout ce qu'on peut produire. ──
  if (importW > 0) {
    st.exportSinceTs = null;
    return apply(hi, 'import', `soutirage ${Math.round(importW)} W — plafond au maximum`);
  }

  // ── 4. Injection : n'agir que si elle PERSISTE (le matériel a eu sa chance). ──
  if (exportW > cfg.exportOnW) {
    if (st.exportSinceTs === null) st.exportSinceTs = inputs.now;
    const heldSec = (inputs.now - st.exportSinceTs) / 1000;
    if (heldSec < cfg.exportSustainSec)
      return {
        mode: 'hold',
        writeW: null,
        targetW: cur,
        reason: `injection ${Math.round(exportW)} W depuis ${Math.round(heldSec)} s — on laisse la Max AC agir`,
        nextState: st
      };
    // Cible = production actuelle MOINS l'excédent mesuré, moins une marge.
    const target = inputs.apsW - exportW - cfg.marginW;
    return apply(
      target,
      'throttle',
      `injection ${Math.round(exportW)} W soutenue — plafond ${Math.round(clamp(target, lo, hi))} W (APS ${Math.round(inputs.apsW)} W)`
    );
  }

  // ── 5. Réseau propre : remonter par paliers pour retrouver le maximum. ──
  if (exportW <= cfg.exportClearW) {
    st.exportSinceTs = null;
    if (cur >= hi)
      return {
        mode: 'hold',
        writeW: null,
        targetW: hi,
        reason: 'plafond déjà au maximum',
        nextState: st
      };
    const sinceWrite = st.lastWriteTs === null ? Infinity : (inputs.now - st.lastWriteTs) / 1000;
    if (sinceWrite < cfg.raiseDwellSec)
      return {
        mode: 'hold',
        writeW: null,
        targetW: cur,
        reason: `réseau propre — remontée dans ${Math.round(cfg.raiseDwellSec - sinceWrite)} s`,
        nextState: st
      };
    return apply(
      cur + cfg.raiseStepW,
      'raise',
      `réseau propre — remontée à ${Math.round(clamp(cur + cfg.raiseStepW, lo, hi))} W`
    );
  }

  // ── Zone intermédiaire (entre clear et on) : on ne touche à rien. ──
  st.exportSinceTs = null;
  return {
    mode: 'hold',
    writeW: null,
    targetW: cur,
    reason: `injection ${Math.round(exportW)} W tolérée — plafond maintenu`,
    nextState: st
  };
}

/** Lecture du pont réduite à ce dont le réarmement a besoin. */
export interface ApsRearmRead {
  available: boolean;
  writeEnabled: boolean;
  powerW: number;
}

export interface ApsRearmVerdict {
  rearm: boolean;
  /** Motif du refus, à journaliser tel quel (null quand on réarme). */
  note: string | null;
}

/**
 * Faut-il rallumer la protection après un arrêt de sécurité ?
 *
 * La consigne « aucune réinjection » n'a pas de pause : un garde-fou qui s'est
 * coupé doit revenir dès que les conditions sont saines. Mais pas n'importe
 * comment — on exige un onduleur JOIGNABLE, OUVERT à l'écriture et ÉVEILLÉ
 * (il produit) : réarmer sur un onduleur endormi rejouerait la panne d'origine.
 * Le quota journalier borne le va-et-vient si le pont refuse vraiment.
 *
 * Pur : l'appelant fournit l'horloge et la lecture du pont.
 */
export function shouldRearmAps(
  st: { autoDisabledReason: string | null; autoDisabledTs: number | null; rearmCount: number },
  now: number,
  aps: ApsRearmRead | null,
  opts: { delayMs: number; maxPerDay: number }
): ApsRearmVerdict {
  const raison = st.autoDisabledReason;
  if (!raison) return { rearm: false, note: null }; // arrêt manuel : jamais contourné
  if (st.autoDisabledTs === null)
    return { rearm: false, note: `${raison} — réarmement automatique programmé` };
  if (now - st.autoDisabledTs < opts.delayMs)
    return { rearm: false, note: `${raison} — réarmement dans quelques minutes` };
  if (st.rearmCount >= opts.maxPerDay)
    return { rearm: false, note: `${raison} — réarmements du jour épuisés` };
  if (!aps || !aps.available || !aps.writeEnabled)
    return { rearm: false, note: `${raison} — onduleur injoignable` };
  if (aps.powerW <= 0)
    return { rearm: false, note: `${raison} — onduleur endormi, réarmement différé` };
  return { rearm: true, note: null };
}
