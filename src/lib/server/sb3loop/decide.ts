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
import type { Sb3Decision, Sb3LoopConfig, Sb3LoopInputs, Sb3LoopState, SlowBias } from './types';

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
 * La part suit la RÈGLE 2 : prorata de l'énergie utilisable, la Max AC prend
 * automatiquement le complément. Mêmes yeux que decide() : sans mesures
 * locales fraîches ni mode manuel Anker, pas de mains.
 */
export function feedforwardTarget(
  inputs: Sb3LoopInputs,
  cfg: Sb3LoopConfig,
  state: Sb3LoopState,
  stepW: number
): FeedforwardTarget {
  if (!inputs.em50.ok || !inputs.maxac.ok) {
    return { ok: false, reason: 'mesures locales muettes — pas de feedforward' };
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
  const maxAcUsableWh = usableWh(inputs.maxac.socPct, inputs.maxac.ratedEnergyWh, cfg.reservePct);
  const parkUsableWh = sb3UsableWh + maxAcUsableWh;
  const share = parkUsableWh > 0 ? sb3UsableWh / parkUsableWh : 0;

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
  // Voie lente : on repart de la mémoire existante, `applyTarget` la met à jour.
  const slowIn: SlowBias = state.slow ?? {
    sinceTs: null,
    signW: null,
    lastWriteTs: null,
    gridSumW: 0,
    gridN: 0,
    gridSinceTs: null
  };
  let slow: SlowBias = slowIn;
  const noWrite = (
    mode: Sb3Decision['mode'],
    reason: string,
    houseLoadW: number | null = null,
    targetW: number | null = null
  ): Sb3Decision => ({ writeW: null, targetW, mode, reason, houseLoadW, enVol, slow });

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
        houseLoadW: null,
        enVol: can ? [...enVol, { ts: inputs.now, dW: step - currentW }] : enVol,
        // Dégradation de sûreté : le biais lent n'a plus de sens sans le cloud.
        slow: { ...slowIn, sinceTs: null, signW: null }
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
  // Erreur EFFECTIVE = ce que le compteur montre MOINS ce qu'on a déjà commandé
  // et qu'il n'a pas encore vu. Sans ce retranchement, on commande deux fois la
  // même correction : mesuré en service le 28/07, cycle limite de période 2 min
  // (soutirage 800 W → injection 786 W → soutirage 814 W…), 864 écritures/jour.
  // Avec, le retard sort de la boucle : correction PLEINE et immédiate, stable.
  const erreurW = Math.round(gridW - dejaCommandeW);

  // ── GARDE RÈGLE 0 : ne JAMAIS baisser la consigne pendant que la Max AC débite ──
  // Invariant physique : à charge maison donnée, baisser la sortie des SB3 reporte
  // exactement autant sur la Max AC. Si elle DÉCHARGE déjà, la baisser l'épuise —
  // et comme elle porte 3 540 W des 5 940 W du parc, c'est la puissance du parc
  // qu'on détruit. Une Max AC qui débite prouve d'ailleurs que les SB3 ne sur-
  // livrent PAS (sinon elle chargerait) : l'injection vient de SA propre
  // régulation, pas de nous. Baisser serait donc doublement faux.
  // Mesuré le 31/07 : injection de 30 à 227 W (dépassement de la régulation Max AC)
  // → la boucle a descendu la consigne 381 → 242 → 15 W, la Max AC est passée de
  // 3 110 à 3 170 W de décharge et de 15 % à 14 % pendant que les SB3 montaient
  // à 35 %. Cercle vicieux exact.
  const maxAcDebite = inputs.maxac.acNetW > cfg.deadbandW;
  // Pré-armement cumulus en cours : la consigne vient d'être montée EXPRÈS,
  // AVANT l'échelon de charge — l'excédent transitoire n'est pas une erreur à
  // corriger. Baisses suspendues quelques secondes ; montées toujours libres.
  const ffHold = (state.ffHoldUntilTs ?? 0) > inputs.now;
  const baisseInterdite = erreurW < 0 && (maxAcDebite || ffHold);

  // ── MOYENNE GLISSANTE DE L'ERREUR COMPTEUR (04/09) ────────────────────────
  // Le compteur bruite de ±30 W. Jugée sur sa valeur INSTANTANÉE, une erreur de
  // 20 W déclenche la voie compteur un tick sur deux, la voie partage l'autre —
  // les deux demandent des corrections de sens opposé, le chrono repart à zéro
  // à chaque fois et plus rien n'est jamais écrit. Mesuré le 04/09 : cible 204,
  // puis 92, puis 217 W, consigne figée à 184 W, zéro écriture en vingt minutes.
  // Un BIAIS survit à la moyenne ; le bruit non. On accumule donc l'erreur, et
  // c'est SA MOYENNE qui a le droit d'ouvrir la voie lente.
  const gridFenetreMs = cfg.slowHoldS * 1000;
  const accVieux =
    slowIn.gridSinceTs !== null && inputs.now - slowIn.gridSinceTs > 2 * gridFenetreMs;
  const gridSumW = (accVieux ? 0 : (slowIn.gridSumW ?? 0)) + erreurW;
  const gridN = (accVieux ? 0 : (slowIn.gridN ?? 0)) + 1;
  const gridSinceTs = accVieux || slowIn.gridSinceTs === null ? inputs.now : slowIn.gridSinceTs;
  slow = { ...slowIn, gridSumW, gridN, gridSinceTs };
  const erreurMoyenneW = gridN > 0 ? gridSumW / gridN : 0;
  const fenetreMure = inputs.now - gridSinceTs >= gridFenetreMs;

  // Seuil d'ENTRÉE (01/09) : au-dessus de la bande morte,
  // `applyTarget` écrit immédiatement, comme avant ; en dessous, il confie
  // l'écart à la voie lente au lieu de l'oublier. C'est ce qui manquait pour que
  // les 20-40 W d'injection permanente cessent d'être invisibles à la boucle.
  // La règle 1 passe donc toujours AVANT le partage (règle 2), y compris pour un
  // biais de quelques dizaines de watts.
  const voieCompteur =
    Math.abs(erreurW) > cfg.deadbandW || // urgent : gain plein, immédiat
    (fenetreMure && Math.abs(erreurMoyenneW) >= cfg.slowMinW); // biais confirmé
  if (voieCompteur && !baisseInterdite) {
    const cible = clamp(base + erreurW, 0, cfg.maxPresetW);
    const enAttente = dejaCommandeW !== 0 ? ` (${Math.round(dejaCommandeW)} W déjà en vol)` : '';
    return applyTarget(
      base + erreurW,
      (Math.abs(erreurW) > cfg.deadbandW
        ? gridW > 0
          ? `SOUTIRAGE ${gridW} W${enAttente}`
          : `injection ${-gridW} W${enAttente}`
        : `biais compteur ${Math.round(erreurMoyenneW)} W en moyenne sur ` +
          `${Math.round((inputs.now - gridSinceTs) / 1000)} s`) + ` — consigne ${base} → ${cible} W`
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
  // ── RÈGLE 0 — RÉÉQUILIBRAGE DE CHARGE : rendre la puissance du parc au parc ──
  // Les 5 900 W émissibles doivent rester disponibles EN PERMANENCE. La Max AC
  // porte 3 540 W des 5 940 : la laisser sous sa réserve, c'est perdre 60 % de la
  // puissance du parc — mesuré le 31/07, 1 854 Wh encore en stock mais seulement
  // 2 400 W mobilisables, et 800 W achetés à EDF pour un cumulus de 2,9 kW.
  //
  // Le prorata en DÉCHARGE ne peut pas réparer ça : avec dEᵢ/dt = −Eᵢ·P/ΣE on a
  // d(Eᵢ/Eⱼ)/dt = 0 — le rapport entre batteries est un INVARIANT. Il conserve le
  // déséquilibre au lieu de le corriger, et une batterie à sa réserve a une part
  // nulle : elle en est exclue définitivement. SEULE LA RECHARGE rééquilibre.
  //
  // Le levier : les SB3 ont leur PV en DC. Ce qu'elles n'envoient pas en AC, elles
  // le gardent pour elles. Monter la consigne DÉTOURNE ce PV vers le bus AC, où la
  // Max AC peut l'absorber (vérifié en direct : elle charge à 150-290 W, réseau
  // tenu à ±70 W). C'est le seul chemin qui la remonte.
  const fracLibre = (soc: number): number =>
    Math.max(0, Math.min(1, (soc - cfg.reservePct) / (100 - cfg.reservePct)));
  const fracMaxAc = fracLibre(inputs.maxac.socPct);
  // SoC moyen des SB3 pondéré par leur CAPACITÉ (deux packs identiques ici, mais
  // la pondération reste juste si l'un est remplacé par un modèle différent).
  const capSb3 = inputs.cloud.sb3Packs.reduce((a, p) => a + p.capacityWh, 0);
  const socSb3 =
    capSb3 > 0
      ? inputs.cloud.sb3Packs.reduce((a, p) => a + p.socPct * p.capacityWh, 0) / capSb3
      : null;
  const fracSb3 = socSb3 === null ? fracMaxAc : fracLibre(socSb3);
  // PV que les SB3 gardent en DC — c'est exactement ce qui est détournable.
  const pvGardeW = Math.max(0, (inputs.cloud.sb3PvW ?? 0) - sb3Out);

  if (
    // Règle 1 servie (rien d'urgent), OU baisse interdite par la règle 0 : dans
    // les deux cas le rééquilibrage est la bonne action, pas l'attente.
    (Math.abs(gridW) <= cfg.deadbandW || baisseInterdite) &&
    !settling &&
    fracMaxAc < fracSb3 - cfg.rebalanceBandFrac && // la Max AC est la retardataire
    pvGardeW > cfg.deadbandW // il y a réellement du PV à détourner
  ) {
    const cible = sb3Out + cfg.rebalanceGain * pvGardeW;
    return applyTarget(
      cible,
      `RÉÉQUILIBRAGE — Max AC à ${Math.round(fracMaxAc * 100)} % de sa plage contre ` +
        `${Math.round(fracSb3 * 100)} % pour les SB3 : ${Math.round(pvGardeW)} W de PV détournables ` +
        `vers elle (consigne ${base} → ${Math.round(clamp(cible, 0, cfg.maxPresetW))} W)`
    );
  }

  const battTotalW = Math.max(0, sb3Out + inputs.maxac.acNetW);
  // BORNE PHYSIQUE DU RÉÉQUILIBRAGE (règle 1 avant règle 2). Déplacer la part
  // des SB3 vers la Max AC n'est possible que si la Max AC peut effectivement
  // reprendre le relais : baisser la consigne de Δ lui demande Δ de plus, la
  // monter de Δ lui demande d'absorber Δ. Au-delà de sa réserve de puissance,
  // le rééquilibrage crée un SOUTIRAGE — mesuré en direct le 28/07 : un saut
  // de −1 291 W a produit 867 W d'achat EDF instantané, que la boucle a dû
  // rattraper au tick suivant. Le partage est un confort ; acheter est interdit.
  const marge = Math.max(0, cfg.maxAcPowerW - Math.abs(inputs.maxac.acNetW));
  const cibleBrute = shareSb3 * battTotalW;
  // Approche PROGRESSIVE de la cible de partage. Sauter dessus d'un coup fait
  // basculer la charge d'une batterie à l'autre plus vite que la Max AC ne peut
  // suivre : mesuré le 28/07, un saut de −1 291 W a créé 867 W d'achat EDF
  // instantané. On corrige une fraction de l'écart par cycle, en restant dans la
  // marge de puissance de la Max AC. Cela ne diffère AUCUNE réponse à la maison :
  // le soutirage et l'injection sont traités à gain plein juste au-dessus.
  const base0 = currentW ?? 0;
  // ...mais SOUS la bande morte, le pas progressif se mord la queue : il rabote
  // un écart déjà petit jusqu'à le faire passer sous le seuil de la voie lente,
  // et le partage se fige à mi-chemin (simulé sur une nuit : les SB3 restaient à
  // 49 % de la charge au lieu des 30 % que leur réserve commande). Un écart de
  // moins de `deadbandW` ne peut pas déstabiliser la Max AC — c'est justement
  // l'ordre de grandeur que la bande morte juge négligeable. On vise donc la
  // cible pleine, en restant borné par sa marge de puissance.
  const petitEcart = Math.abs(cibleBrute - base0) <= cfg.deadbandW;
  const progressif = petitEcart ? cibleBrute : base0 + cfg.shareGain * (cibleBrute - base0);
  const borne = clamp(progressif, base0 - marge, base0 + marge);
  return applyTarget(
    borne,
    `répartition — part SB3 ${pctSb3} % de ${battTotalW} W batterie ` +
      (Math.abs(cibleBrute - borne) > 1
        ? `[borné par la marge Max AC ${Math.round(marge)} W] `
        : '') +
      `(${Math.round(sb3UsableWh / 100) / 10}/${Math.round(parkUsableWh / 100) / 10} kWh utilisables)`
  );

  /**
   * Bande morte EN WATTS : une résolution, pas un délai.
   *
   * ── VOIE LENTE (01/09/2026) ────────────────────────────────────────────────
   * La bande morte est taillée pour le jour, où la charge se compte en kW. La
   * nuit, la charge totale vaut ~130 W : tout écart utile passe dessous, et la
   * boucle se fige. Mesuré dans la nuit du 31/08 au 01/09 — cible calculée
   * 111 W, consigne restée à 178 W, « écrit: None » à chaque tick pendant des
   * heures. Deux symptômes, une seule cause : les SB3 (58 %) se vidaient seules
   * pendant que la Max AC (86 %) restait au repos, et ~600 Wh/jour partaient au
   * réseau en continu, jour et nuit.
   *
   * Un correcteur proportionnel à bande morte laisse par construction une erreur
   * STATIQUE. On lui ajoute la seule chose qui l'élimine : la mémoire du temps.
   * Un écart trop petit pour la voie rapide n'est plus oublié — s'il tient
   * `slowHoldS` dans le MÊME sens et dépasse `slowMinW`, il est corrigé.
   *
   * Ce n'est pas une réaction différée au sens de la règle 3 : les échelons de
   * charge, eux, franchissent la bande morte et sont traités à gain plein et
   * sans délai, exactement comme avant. Ce qu'on rattrape ici, c'est un biais
   * permanent, qui par définition n'a pas d'urgence — seulement une fin.
   */
  function applyTarget(rawW: number, reason: string): Sb3Decision {
    const targetW = Math.round(clamp(rawW, 0, cfg.maxPresetW));
    const ecartW = currentW === null ? 0 : targetW - currentW;

    if (currentW !== null && Math.abs(ecartW) <= cfg.deadbandW) {
      const signW: 1 | -1 = ecartW >= 0 ? 1 : -1;
      // Trop petit pour être un biais : on oublie et on repart de zéro.
      if (Math.abs(ecartW) < cfg.slowMinW) {
        slow = { ...slowIn, sinceTs: null, signW: null };
        return noWrite('allocate', `${reason} — dans la bande morte`, houseLoadW, targetW);
      }
      // Changement de sens = ce n'est pas un biais, c'est du bruit : on redémarre.
      const continu = slowIn.signW === signW && slowIn.sinceTs !== null;
      const sinceTs = continu ? (slowIn.sinceTs as number) : inputs.now;
      slow = { ...slowIn, sinceTs, signW };

      const tenuS = (inputs.now - sinceTs) / 1000;
      const depuisEcritureS =
        slowIn.lastWriteTs === null ? Infinity : (inputs.now - slowIn.lastWriteTs) / 1000;
      if (tenuS < cfg.slowHoldS) {
        return noWrite(
          'allocate',
          `${reason} — biais de ${Math.round(ecartW)} W tenu depuis ${Math.round(tenuS)} s`,
          houseLoadW,
          targetW
        );
      }
      if (depuisEcritureS < cfg.slowMinIntervalS) {
        return noWrite(
          'allocate',
          `${reason} — biais confirmé, prochaine correction lente dans ` +
            `${Math.round(cfg.slowMinIntervalS - depuisEcritureS)} s`,
          houseLoadW,
          targetW
        );
      }
      // Biais confirmé et cadence respectée : on corrige, et on repart à zéro.
      // Écriture : le biais ET la moyenne repartent de zéro — ce qui était
      // accumulé vient d'être corrigé.
      slow = {
        ...slow,
        sinceTs: null,
        signW: null,
        lastWriteTs: inputs.now,
        gridSumW: 0,
        gridN: 0,
        gridSinceTs: inputs.now
      };
      return {
        writeW: targetW,
        targetW,
        mode: 'allocate',
        reason: `${reason} — biais de ${Math.round(ecartW)} W tenu ${Math.round(tenuS)} s, corrigé`,
        houseLoadW,
        enVol: [...enVol, { ts: inputs.now, dW: ecartW }],
        slow
      };
    }

    // La correction part « en vol » : elle sera retranchée de l'erreur mesurée
    // tant que le compteur n'a pas eu le temps de la refléter.
    const dW = targetW - (currentW ?? 0);
    // Une écriture rapide remet le biais à zéro : la consigne vient de bouger,
    // ce qui était « tenu » ne l'est plus — la moyenne d'erreur non plus.
    slow = { ...slow, sinceTs: null, signW: null, gridSumW: 0, gridN: 0, gridSinceTs: inputs.now };
    return {
      writeW: targetW,
      targetW,
      mode: 'allocate',
      reason,
      houseLoadW,
      enVol: [...enVol, { ts: inputs.now, dW }],
      slow
    };
  }
}

/**
 * Faut-il rallumer la boucle après un arrêt de sécurité ?
 *
 * Même principe que pour le bridage de l'onduleur : la consigne « aucune
 * réinjection » ne s'interrompt pas, un arrêt de sécurité ne peut donc pas être
 * définitif. Le 29/08/2026 la boucle s'est coupée à 11h43 sur deux consignes non
 * confirmées et n'est jamais revenue : parc figé à 0 W de sortie, batteries
 * pleines, tout le solaire parti sur le réseau jusqu'au soir.
 *
 * On ne relance pas à l'aveugle : c'est le tick suivant qui vérifiera le cloud
 * et re-coupera de lui-même si la panne dure (deux consignes non prises). Le
 * quota journalier borne ce va-et-vient. EXCEPTION : une faute de schéma
 * (canary) ne se répare pas toute seule — elle attend une vérification humaine.
 */
export function shouldRearmSb3(
  st: { autoDisabledReason: string | null; autoDisabledTs: number | null; rearmCount: number },
  now: number,
  opts: { delayMs: number; maxPerDay: number }
): boolean {
  const raison = st.autoDisabledReason;
  if (!raison) return false; // arrêt manuel : jamais contourné
  if (raison.startsWith('canary')) return false;
  if (st.autoDisabledTs === null) return false;
  if (now - st.autoDisabledTs < opts.delayMs) return false;
  return st.rearmCount < opts.maxPerDay;
}
