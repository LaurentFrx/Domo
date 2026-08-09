/**
 * Loi de commande de la boucle SB3 — fonction PURE (testable sans réseau).
 *
 * ⚠️ CETTE BOUCLE N'A PLUS D'OBJET DEPUIS LE 09/08/2026.
 * Elle avait été écrite parce que les SB3 n'avaient pas de compteur : consigne
 * fixe à 300 W, ~165 W de batterie injectés en permanence, ~9 kWh/mois perdus.
 * Le Smart Meter Gen 2 leur est désormais rattaché et elles sont en mode
 * AUTOCONSOMMATION : elles asservissent le compteur elles-mêmes, en secondes, en
 * local (mesuré à l'EM-50 le 09/08 : réseau entre −37 et −99 W, zéro soutirage).
 * En mode autoconsommation la consigne système n'est même plus LUE — vérifié :
 * preset 200 W affiché pendant que 793 W sortaient réellement.
 *
 * La garde « mode Anker ≠ manuel » ci-dessous rend donc la main à chaque tick, et
 * c'est très bien ainsi. La loi est conservée — correcte pour deux SB3 — au cas
 * où Laurent repasserait un jour en plan personnalisé, mais elle ne commande plus
 * rien tant que le mode reste 1.
 *
 * ⛔ RÈGLES ABSOLUES posées par Laurent (28/07/2026) :
 *   1. NE JAMAIS SOUTIRER SUR LE RÉSEAU EDF. Tant qu'il reste de l'énergie
 *      utilisable dans le parc, elle sort.
 *   2. (Le prorata entre batteries est devenu sans objet : deux packs identiques,
 *      répartis par le firmware — 200 W système = 100 + 100, vérifié.)
 *   3. AUCUN PALIER, AUCUNE RÉACTION DIFFÉRÉE : « une consommation électrique du
 *      foyer est immédiate et jamais graduelle ». Plus de rampe (slew), plus de
 *      temporisation (dwell), plus de confirmation sur N évaluations.
 *
 * Hiérarchie d'évaluation :
 *  1. FAIL-SAFE local : EM-50 muet → AUCUNE écriture (sans les yeux, pas de mains).
 *  2. FAIL-LOW cloud : données cloud périmées → house_load inconnue ; on redescend
 *     par paliers (seul endroit où un palier subsiste : c'est une dégradation de
 *     sûreté, pas une réponse à la charge).
 *  3. Mode Anker ≠ manuel → nos écritures ne gouvernent rien, on attend. ← le
 *     chemin emprunté en permanence depuis le 09/08.
 *  4. Couverture intégrale du soutirage mesuré (pilotage sur l'erreur compteur).
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

export type FeedforwardTarget =
  | { ok: true; targetW: number; baseW: number; sharePct: number }
  | { ok: false; reason: string };

/**
 * Cible de FEEDFORWARD pour un échelon de charge que NOUS commandons
 * (cumulus : fermeture ou ouverture du relais). L'instant de l'échelon étant
 * choisi, monter la part SB3 AVANT de fermer — et la rendre à l'ouverture —
 * supprime le transitoire à la source, sans prédiction (étude §8, banc §10).
 *
 * stepW SIGNÉ : + la charge va apparaître (pré-armement), − elle disparaît.
 * Mêmes yeux que decide() : sans mesures locales fraîches ni mode manuel Anker,
 * pas de mains.
 */
export function feedforwardTarget(
  inputs: Sb3LoopInputs,
  cfg: Sb3LoopConfig,
  state: Sb3LoopState,
  stepW: number
): FeedforwardTarget {
  if (!inputs.em50.ok) {
    return { ok: false, reason: 'EM-50 muet — pas de feedforward' };
  }
  const cloudFresh =
    inputs.cloud.ok && inputs.cloud.freshS !== null && inputs.cloud.freshS <= cfg.cloudStaleS;
  if (!cloudFresh) return { ok: false, reason: 'cloud périmé — pas de feedforward' };
  if (inputs.cloud.sceneMode !== 3) {
    return { ok: false, reason: `mode Anker ${inputs.cloud.sceneMode} ≠ manuel` };
  }

  const sb3UsableWh = inputs.cloud.sb3Packs.reduce(
    (s, p) => s + usableWh(p.socPct, p.capacityWh, cfg.reservePct),
    0
  );
  if (stepW > 0 && sb3UsableWh <= 0) {
    return { ok: false, reason: `SB3 à leur réserve (${cfg.reservePct} %) — rien à pré-armer` };
  }
  // Les SB3 sont désormais SEULES dans le parc (Max AC retirée le 09/08/2026) :
  // l'échelon leur revient en entier, il n'y a plus de complément à laisser à
  // personne. La part vaut donc 1 tant qu'il leur reste de l'énergie utilisable.
  const share = sb3UsableWh > 0 ? 1 : 0;

  const base = clamp(state.lastCmdW ?? inputs.cloud.sb3PresetW ?? 0, 0, cfg.maxPresetW);
  const targetW = Math.round(clamp(base + share * stepW, 0, cfg.maxPresetW));
  if (Math.abs(targetW - base) <= cfg.deadbandW) {
    return { ok: false, reason: 'écart dans la bande morte — rien à écrire' };
  }
  return { ok: true, targetW, baseW: base, sharePct: Math.round(share * 100) };
}

export function decide(
  inputs: Sb3LoopInputs,
  cfg: Sb3LoopConfig,
  state: Sb3LoopState
): Sb3Decision {
  // ── PRÉDICTEUR DE SMITH : corrections déjà commandées, pas encore visibles ──
  // On purge la file de ce qui a eu le temps d'agir ; ce qui reste est ce que le
  // compteur n'a pas encore « vu ». Cf. docs/regulation-energie.md §3-4.
  const enVol = (state.enVol ?? []).filter((c) => inputs.now - c.ts < cfg.enVolS * 1000);
  const dejaCommandeW = enVol.reduce((s, c) => s + c.dW, 0);
  const noWrite = (
    mode: Sb3Decision['mode'],
    reason: string,
    houseLoadW: number | null = null,
    targetW: number | null = null
  ): Sb3Decision => ({ writeW: null, targetW, mode, reason, houseLoadW, enVol });

  // Consigne « en place » de référence : la dernière écrite par la boucle, sinon
  // celle vue par le cloud (ancrage au premier cycle). CLAMPÉE : une valeur cloud
  // aberrante ne doit jamais servir de référence à la bande morte.
  const rawCurrent = state.lastCmdW ?? inputs.cloud.sb3PresetW;
  const currentW = rawCurrent === null ? null : clamp(rawCurrent, 0, cfg.maxPresetW);

  // ── 1. Fail-safe local : sans les yeux, pas de mains. ──
  if (!inputs.em50.ok) {
    return noWrite('failsafe', 'EM-50 muet — aucune écriture');
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
        houseLoadW: null,
        enVol: can ? [...enVol, { ts: inputs.now, dW: step - currentW }] : enVol
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
  // Réseau signé + APS + sortie SB3.
  const houseLoadW = Math.max(0, Math.round(inputs.em50.gridW + inputs.aps.powerW + sb3Out));

  // ── RÈGLE 2 — SANS OBJET depuis le 09/08/2026 ────────────────────────────
  // Le prorata existait pour que trois batteries de tailles différentes
  // atteignent leur réserve ensemble, la troisième prenant le complément sans
  // être commandée. Cette batterie est sortie du parc : il ne reste que deux SB3
  // identiques, et le firmware répartit lui-même la consigne système entre elles
  // (vérifié : 200 W système = 100 + 100). Il n'y a plus rien à répartir ici.
  const sb3UsableWh = inputs.cloud.sb3Packs.reduce(
    (s, p) => s + usableWh(p.socPct, p.capacityWh, cfg.reservePct),
    0
  );

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
  // Erreur EFFECTIVE = ce que le compteur montre MOINS ce qu'on a déjà commandé
  // et qu'il n'a pas encore vu. Sans ce retranchement, on commande deux fois la
  // même correction : mesuré en service le 28/07, cycle limite de période 2 min
  // (soutirage 800 W → injection 786 W → soutirage 814 W…), 864 écritures/jour.
  // Avec, le retard sort de la boucle : correction PLEINE et immédiate, stable.
  const erreurW = Math.round(gridW - dejaCommandeW);

  // ── (La garde « ne jamais baisser pendant que la Max AC débite » est tombée
  //     avec elle, le 09/08/2026 : il n'y a plus de seconde batterie sur qui
  //     reporter la charge, donc plus de cercle vicieux à empêcher.) ──
  // Pré-armement cumulus en cours : la consigne vient d'être montée EXPRÈS,
  // AVANT l'échelon de charge — l'excédent transitoire n'est pas une erreur à
  // corriger. Baisses suspendues quelques secondes ; montées toujours libres.
  const ffHold = (state.ffHoldUntilTs ?? 0) > inputs.now;
  const baisseInterdite = erreurW < 0 && ffHold;

  if (Math.abs(erreurW) > cfg.deadbandW && !baisseInterdite) {
    const cible = clamp(base + erreurW, 0, cfg.maxPresetW);
    const enAttente = dejaCommandeW !== 0 ? ` (${Math.round(dejaCommandeW)} W déjà en vol)` : '';
    return applyTarget(
      base + erreurW,
      gridW > 0
        ? `SOUTIRAGE ${gridW} W${enAttente} — consigne ${base} → ${cible} W`
        : `injection ${-gridW} W${enAttente} — consigne ${base} → ${cible} W`
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
  // ── RÉÉQUILIBRAGE DU PARC — SUPPRIMÉ le 09/08/2026 ────────────────────────
  // Tout ce bloc (règle 0) servait à remonter la Max AC : elle portait 3 540 W
  // des 5 940 du parc et, tombée à sa réserve, elle coûtait 60 % de la puissance
  // disponible. Le levier était de détourner vers le bus AC le PV que les SB3
  // gardaient en DC, pour qu'elle l'absorbe. Elle a quitté l'installation : il
  // reste deux packs identiques que le firmware équilibre lui-même, et il n'y a
  // plus de batterie à qui rendre quoi que ce soit.
  //
  // Le compteur est à l'équilibre et il n'y a plus rien à arbitrer : on tient la
  // consigne. C'est aussi le seul chemin qu'atteint encore cette fonction en
  // pratique — depuis que les SB3 sont en autoconsommation, la garde `sceneMode
  // !== 3` plus haut rend la main bien avant.
  return noWrite('allocate', 'compteur à l’équilibre — consigne tenue', houseLoadW, base);

  /** Bande morte EN WATTS : une résolution, pas un délai. */
  function applyTarget(rawW: number, reason: string): Sb3Decision {
    const targetW = Math.round(clamp(rawW, 0, cfg.maxPresetW));
    if (currentW !== null && Math.abs(targetW - currentW) <= cfg.deadbandW) {
      return noWrite('allocate', `${reason} — dans la bande morte`, houseLoadW, targetW);
    }
    // La correction part « en vol » : elle sera retranchée de l'erreur mesurée
    // tant que le compteur n'a pas eu le temps de la refléter.
    const dW = targetW - (currentW ?? 0);
    return {
      writeW: targetW,
      targetW,
      mode: 'allocate',
      reason,
      houseLoadW,
      enVol: [...enVol, { ts: inputs.now, dW }]
    };
  }
}
