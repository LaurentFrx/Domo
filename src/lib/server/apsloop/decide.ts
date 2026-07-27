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

  // ── 2. Onduleur endormi (nuit) : on rend le plafond pour le lever du jour. ──
  if (!inputs.apsAvailable) {
    st.exportSinceTs = null;
    return apply(hi, 'night', 'onduleur endormi — plafond rendu au maximum pour demain');
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
