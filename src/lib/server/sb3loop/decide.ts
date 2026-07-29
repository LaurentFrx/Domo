/**
 * Loi de commande de la boucle SB3 — fonction PURE (testable sans réseau).
 *
 * ⛔ RÈGLES ABSOLUES posées par Laurent (28/07/2026), dans cet ordre :
 *   1. NE JAMAIS SOUTIRER SUR LE RÉSEAU EDF. Tant qu'il reste de l'énergie
 *      utilisable dans le parc, elle sort. AUCUNE convention de « charge
 *      prioritaire » ne bloque jamais la décharge d'une Solarbank.
 *   2. Charge et décharge se répartissent AU PRORATA des kWh utilisables de
 *      chaque batterie, réserve de 10 % déduite — pour qu'elles atteignent leur
 *      plancher EN MÊME TEMPS, jamais l'une vidée pendant que l'autre est pleine.
 *   3. AUCUN PALIER, AUCUNE RÉACTION DIFFÉRÉE : « une consommation électrique du
 *      foyer est immédiate et jamais graduelle ». Plus de rampe (slew), plus de
 *      temporisation (dwell), plus de confirmation sur N évaluations.
 *
 * Ce que ça a remplacé : une règle « jour » qui posait consigne 0 « parce que les
 * SB3 chargent » — le 28/07 la maison achetait 2 079 W à EDF pendant que 5,4 kWh
 * dormaient dans deux packs pleins et que la Max AC s'épuisait seule.
 *
 * Hiérarchie d'évaluation :
 *  1. FAIL-SAFE local : EM-50 ou Modbus Max AC muets → AUCUNE écriture (sans les
 *     yeux, pas de mains).
 *  2. FAIL-LOW cloud : données cloud périmées → house_load inconnue ; on redescend
 *     par paliers (seul endroit où un palier subsiste : c'est une dégradation de
 *     sûreté, pas une réponse à la charge).
 *  3. Mode Anker ≠ manuel → nos écritures ne gouvernent rien, on attend.
 *  4. ALLOCATION PROPORTIONNELLE + couverture intégrale du soutirage mesuré.
 *
 * Seul amortisseur conservé : une bande morte EN WATTS, qui n'introduit aucun
 * retard — elle évite de réécrire une valeur quasi identique (chaque écriture est
 * un login propriétaire sur le cloud Anker). La substitution `settle` n'est pas
 * un délai non plus : elle remplace une lecture cloud périmée par la consigne
 * réellement écrite, ce qui rend l'estimation PLUS juste.
 */
import type { Sb3Decision, Sb3LoopConfig, Sb3LoopInputs, Sb3LoopState } from './types';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Énergie réellement disponible d'un pack (Wh), réserve déduite. */
export function usableWh(socPct: number, capacityWh: number, reservePct: number): number {
  if (!Number.isFinite(socPct) || !Number.isFinite(capacityWh) || capacityWh <= 0) return 0;
  return Math.max(0, capacityWh * (Math.min(100, Math.max(0, socPct)) - reservePct)) / 100;
}

export function decide(
  inputs: Sb3LoopInputs,
  cfg: Sb3LoopConfig,
  state: Sb3LoopState
): Sb3Decision {
  const noWrite = (
    mode: Sb3Decision['mode'],
    reason: string,
    houseLoadW: number | null = null,
    targetW: number | null = null
  ): Sb3Decision => ({ writeW: null, targetW, mode, reason, houseLoadW });

  // Consigne « en place » de référence : la dernière écrite par la boucle, sinon
  // celle vue par le cloud (ancrage au premier cycle). CLAMPÉE : une valeur cloud
  // aberrante ne doit jamais servir de référence à la bande morte.
  const rawCurrent = state.lastCmdW ?? inputs.cloud.sb3PresetW;
  const currentW = rawCurrent === null ? null : clamp(rawCurrent, 0, cfg.maxPresetW);

  // ── 1. Fail-safe local : sans les yeux, pas de mains. ──
  if (!inputs.em50.ok || !inputs.maxac.ok) {
    return noWrite(
      'failsafe',
      !inputs.em50.ok ? 'EM-50 muet — aucune écriture' : 'Modbus Max AC muet — aucune écriture'
    );
  }

  // ── 2. Fail-low : cloud périmé → décroître d'un palier par cycle. ──
  const cloudFresh =
    inputs.cloud.ok && inputs.cloud.freshS !== null && inputs.cloud.freshS <= cfg.cloudStaleS;
  if (!cloudFresh) {
    if (currentW !== null && currentW > 0) {
      const step = Math.max(0, currentW - cfg.failLowStepW);
      const can =
        state.lastWriteTs === null || inputs.now - state.lastWriteTs >= cfg.failLowDwellS * 1000;
      return {
        writeW: can ? step : null,
        targetW: step,
        mode: 'faillow',
        reason: `cloud périmé — décroissance ${currentW} → ${step} W`,
        houseLoadW: null
      };
    }
    return noWrite('faillow', 'cloud périmé — consigne déjà basse, rien à faire');
  }

  // Le plan personnalisé doit être le mode actif, sinon nos écritures ne
  // gouvernent rien (informational : on attend, on ne désactive pas).
  if (inputs.cloud.sceneMode !== 3) {
    return noWrite('hold', `mode Anker ${inputs.cloud.sceneMode} ≠ manuel — écritures suspendues`);
  }

  // Après une écriture, le sb3Out CLOUD traîne 1-3 min derrière la réalité (le
  // device applique en secondes) : pendant settleS on lui substitue la consigne
  // écrite — sinon la boucle chasse son propre retard (cycle limite).
  const settling =
    state.lastWriteTs !== null &&
    state.lastCmdW !== null &&
    inputs.now - state.lastWriteTs < cfg.settleS * 1000;
  const sb3Out = settling ? (state.lastCmdW as number) : (inputs.cloud.sb3OutW ?? 0);

  // house_load — INFORMATIF SEULEMENT (journal, carte). Elle ne pilote plus rien :
  // voir « pilotage sur l'erreur mesurée » plus bas.
  // Réseau signé + APS + sortie SB3 + flux AC net Max AC SIGNÉ.
  // Le SIGNE est vital (revue 23/07) : en régime de recyclage (consigne > charge
  // réelle, la Max AC absorbe l'excédent à compteur nul), sa CHARGE −(C−H) annule
  // l'excès compté dans sb3Out et l'estimation redonne H — sans le signe, elle
  // dégénérait en « consigne + APS » et toute consigne trop haute s'auto-confirmait.
  const houseLoadW = Math.max(
    0,
    Math.round(inputs.em50.gridW + inputs.aps.powerW + sb3Out + inputs.maxac.acNetW)
  );

  // ── RÈGLE 2 — part des SB3 au prorata de l'énergie UTILISABLE du parc. ──
  // Les trois batteries doivent atteindre leur réserve en même temps : chacune
  // fournit à hauteur de ce qu'elle peut encore donner. La Max AC n'est pas
  // commandée (elle asservit le compteur à zéro toute seule) — on ne pilote que
  // la part SB3, et elle prend automatiquement le reste.
  const sb3UsableWh = inputs.cloud.sb3Packs.reduce(
    (s, p) => s + usableWh(p.socPct, p.capacityWh, cfg.reservePct),
    0
  );
  const maxAcUsableWh = usableWh(inputs.maxac.socPct, inputs.maxac.ratedEnergyWh, cfg.reservePct);
  const parkUsableWh = sb3UsableWh + maxAcUsableWh;
  const shareSb3 = parkUsableWh > 0 ? sb3UsableWh / parkUsableWh : 0;
  const pctSb3 = Math.round(shareSb3 * 100);

  // Plus rien d'utilisable dans les SB3 : demander leur décharge est sans objet.
  if (sb3UsableWh <= 0) {
    return applyTarget(0, `SB3 à leur réserve (${cfg.reservePct} %) — plus rien à donner`);
  }

  // ── PILOTAGE SUR L'ERREUR MESURÉE, jamais sur une charge estimée ──────────
  // Piège trouvé en direct le 28/07 : asservir la consigne à `house_load` la fait
  // figurer dans sa PROPRE entrée (house_load contient sb3Out, et sb3Out ≈ la
  // consigne). Sans temporisation pour masquer le retard du cloud, l'estimation
  // s'emballait — 2 876 → 5 948 → 2 884 W en trois cycles, et la consigne sautait
  // au plafond à chaque bosse. Restaurer une temporisation aurait violé la règle 3.
  // La sortie est structurelle : le COMPTEUR est la seule grandeur instantanée et
  // fiable, et il donne directement l'ERREUR. Déplacer la consigne de l'erreur
  // mesurée ne referme aucune boucle sur elle-même : à l'équilibre, correction
  // nulle. Réponse immédiate ET stable, sans le moindre délai.
  const gridW = inputs.em50.gridW; // + acheté à EDF / − injecté
  const base = currentW ?? sb3Out;

  if (Math.abs(gridW) > cfg.deadbandW) {
    return applyTarget(
      base + gridW,
      gridW > 0
        ? `SOUTIRAGE ${gridW} W — consigne ${base} → ${clamp(base + gridW, 0, cfg.maxPresetW)} W`
        : `injection ${-gridW} W — consigne ${base} → ${clamp(base + gridW, 0, cfg.maxPresetW)} W`
    );
  }

  // Compteur à l'équilibre : rien d'urgent. On profite du calme pour rééquilibrer
  // le PARTAGE entre batteries — mais uniquement sur une mesure SB3 VALIDE. Juste
  // après une écriture le cloud traîne : rééquilibrer sur ce chiffre-là reviendrait
  // à courir après son propre retard. On ne diffère AUCUNE réponse à la maison
  // (l'erreur compteur passe toujours en premier), on attend seulement la donnée
  // nécessaire à un réglage qui, lui, n'a rien d'urgent.
  if (settling) {
    return noWrite(
      'allocate',
      `compteur à l'équilibre — mesure SB3 en cours de rafraîchissement`,
      houseLoadW,
      base
    );
  }
  const battTotalW = Math.max(0, sb3Out + inputs.maxac.acNetW);
  return applyTarget(
    shareSb3 * battTotalW,
    `répartition — part SB3 ${pctSb3} % de ${battTotalW} W batterie ` +
      `(${Math.round(sb3UsableWh / 100) / 10}/${Math.round(parkUsableWh / 100) / 10} kWh utilisables)`
  );

  /** Bande morte EN WATTS : une résolution, pas un délai. */
  function applyTarget(rawW: number, reason: string): Sb3Decision {
    const targetW = Math.round(clamp(rawW, 0, cfg.maxPresetW));
    if (currentW !== null && Math.abs(targetW - currentW) <= cfg.deadbandW) {
      return noWrite('allocate', `${reason} — dans la bande morte`, houseLoadW, targetW);
    }
    return { writeW: targetW, targetW, mode: 'allocate', reason, houseLoadW };
  }
}
