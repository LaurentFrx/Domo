/**
 * Boucle de CHARGE de la Solarbank Max AC — types et réglages.
 *
 * POURQUOI CETTE BOUCLE EXISTE (13/09/2026).
 * Depuis que les SB3 ont leur propre compteur (Smart Meter Gen 1), leur firmware
 * régule seul : pleines, elles COUPENT leur production tant que rien ne la
 * demande. Mesuré le 13/09 : 1 603 W de PV la veille à 14 h, 0 W ce jour-là à la
 * même heure, pendant que la Max AC plafonnait à 39 % au lieu de monter à 82 %.
 * Le compteur a réglé l'injection et cassé la recharge de la Max AC du même coup.
 *
 * Le seul levier est d'aller chercher ce PV en créant une demande VISIBLE au
 * compteur : commander à la Max AC de charger plus que le surplus apparent. Les
 * SB3 voient alors l'appel et rouvrent leur production. Vérifié en réel le même
 * jour : consigne −1 400 W, réseau tenu entre −105 et 0 W pendant quinze
 * secondes, SoC des SB3 immobile à 100 % (c'est bien du PV en transit).
 *
 * CE QUE ÇA COÛTE, ET POURQUOI TOUT EST GARDÉ.
 * Commander la puissance exige le mode « contrôle par un tiers » (10064 = 3),
 * dans lequel la Max AC CESSE de réguler : elle applique la consigne au watt
 * près et rien d'autre. Une consigne trop haute achète, une consigne trop basse
 * injecte — mesuré : consigne 400 W alors qu'elle chargeait 610, les 210 W de
 * différence sont partis au réseau en quelques secondes. D'où :
 *   · un chien de garde INDÉPENDANT sur le RPi4, qui rend la main à l'appareil
 *     dès que Domo se tait 30 s (`ops/maxac-watchdog.py`) ;
 *   · `claimMaxAcControl()` à CHAQUE tick où l'on tient la barre ;
 *   · des conditions d'entrée strictes, et le retour au mode 0 dès que l'une
 *     tombe — le mode sûr est celui où l'appareil se gouverne lui-même.
 */

export interface MaxAcLoopConfig {
  /** Gain de l'asservissement sur l'erreur compteur. < 1 : on ne rattrape pas
   *  tout l'écart d'un coup, parce que les SB3 régulent aussi et qu'un gain
   *  unitaire ferait osciller les deux régulateurs l'un contre l'autre. */
  gain: number;
  /** Tolérance sur l'ERREUR COMPTEUR côté EXPORT (W) : en deçà, on ne corrige
   *  pas. Un léger surplus n'est pas une faute — c'est une marge de sécurité. */
  deadbandW: number;
  /** Tolérance sur l'ERREUR COMPTEUR côté IMPORT (W). VOLONTAIREMENT PRESQUE
   *  NULLE : l'achat est interdit (règle 1), pas « toléré s'il est petit ».
   *  Mesuré le 13/09 à l'activation : avec une bande morte symétrique de 40 W
   *  exprimée sur la CONSIGNE (≈ 67 W au compteur avec le gain 0,6), la boucle
   *  se garait indifféremment sur +30 à +130 W d'achat et y restait. La bande
   *  morte doit porter sur ce qu'on veut annuler — le compteur — et pencher du
   *  côté qui n'est pas interdit. */
  importToleranceW: number;
  /** Variation de consigne en deçà de laquelle on n'écrit pas (W) — évite les
   *  écritures Modbus sans effet, rien de plus. */
  writeEpsilonW: number;
  /** Pas d'EXPLORATION (W). Sans lui la boucle ne monterait jamais : à
   *  l'équilibre le compteur est à zéro, l'erreur est nulle, et l'asservissement
   *  seul se contenterait de la charge spontanée — alors que tout l'objet de la
   *  boucle est d'aller CHERCHER le PV que les SB3 brident. On sonde donc vers
   *  le haut tant que le réseau tient l'équilibre ; si les SB3 ne suivent pas,
   *  l'import apparaît et l'asservissement redescend. Recherche du maximum,
   *  comme la remontée par paliers du bridage APS, en sens inverse. */
  probeStepW: number;
  /** Plafond du pas d'exploration une fois qu'il a fait ses preuves (W).
   *  Le pas DOUBLE à chaque palier réussi et retombe au minimum au premier
   *  échec : monter de 400 à 2 000 W prenait 27 paliers de 60 W, soit 40 min de
   *  production perdue chaque matin ; en doublant, il en faut 6, soit 9 min.
   *  Un palier « réussi » = le compteur n'a pas basculé en achat au tick suivant. */
  probeStepMaxW: number;
  /** Intervalle minimal entre deux paliers d'exploration (ms) — laisser aux SB3
   *  le temps de rouvrir leur production (mesuré : 10 à 20 s). */
  probeEveryMs: number;
  /** Variation maximale de consigne par tick (W) — pas d'échelon brutal : les
   *  SB3 mettent ~10-20 s à répondre, un saut les laisserait derrière et le
   *  compteur partirait en import le temps qu'elles rattrapent. */
  slewW: number;
  /** Plafond absolu de charge commandée (W). L'appareil accepte 3 500 W ; on
   *  reste en dessous tant que la boucle n'a pas fait ses preuves. */
  maxChargeW: number;
  /** Charge minimale commandée (W) : en dessous, l'entrée en mode 3 ne vaut pas
   *  la peine de retirer sa régulation à l'appareil. */
  minChargeW: number;
  /** SoC minimal des SB3 pour agir (%) : sous ce seuil elles ont besoin de leur
   *  PV pour ELLES, et le leur prendre serait un transfert à pertes, pas une
   *  récupération. */
  sb3FullPct: number;
  /** SoC maximal de la Max AC pour agir (%) : au-delà, plus de place à remplir. */
  maxAcRoomPct: number;
  /** PV des SB3 en dessous duquel on considère leur production BRIDÉE (W). */
  sb3PvBridedW: number;
  /** Production APS minimale pour affirmer qu'il fait jour et qu'il y a du
   *  soleil à récupérer (W) — le PV des SB3 étant justement coupé, il ne peut
   *  pas servir de témoin. */
  dayApsW: number;
  /** Puissance cumulus au-delà de laquelle une chauffe est en cours (W) : elle
   *  crée déjà la demande, la boucle n'a rien à faire et lui laisse la place. */
  cumulusOnW: number;
  /** Import au-delà duquel on abandonne immédiatement (W). */
  abortImportW: number;
  /** Injection au-delà de laquelle on REND LA MAIN (W). Symétrique et
   *  indispensable : en mode 3 l'appareil n'absorbe QUE la consigne, donc un
   *  export que la consigne ne peut pas rattraper (plafond atteint) durerait
   *  indéfiniment — alors qu'en mode 0 l'appareil l'aurait absorbé de lui-même.
   *  Le geste qui absorbe, c'est de lui rendre sa régulation. */
  abortExportW: number;
  /** Nombre de ticks consécutifs d'import avant abandon. */
  abortTicks: number;
  /** Durée de mise à l'écart après un abandon (ms). */
  penaltyMs: number;
  /** Au-delà de cette marge, la sortie AC des SB3 dépasse leur PV : ce qu'elles
   *  fournissent vient de leur BATTERIE, pas du soleil. On rend la main. */
  sb3DrainMarginW: number;
  /** Horizon d'absorption : on ne commande jamais plus que ce que le pack peut
   *  encaisser sur cette durée (h) — un pack à 95 % ne prend pas 2 kW. */
  fillHorizonH: number;
  /** Capacité de la Max AC (Wh), pour la place restante. */
  maxAcCapacityWh: number;
}

export const MAXAC_LOOP_DEFAULTS: MaxAcLoopConfig = {
  gain: 0.6,
  deadbandW: 60,
  importToleranceW: 15,
  writeEpsilonW: 15,
  // Pas et cadence RÉGLÉS AU PLUS PRUDENT après simulation (13/09) : un palier
  // à l'aveugle achète pendant que les SB3 rampent (retard 10-20 s puis ~6 W/s).
  // 60 W tenus ~30 s ≈ 0,5 Wh d'achat par palier, contre 3 Wh à 200 W ; et 90 s
  // entre paliers laissent la réponse s'établir au lieu de la lire à mi-course
  // — c'est ce qui entretenait un cycle limite de 170 W au compteur.
  probeStepW: 60,
  probeStepMaxW: 480,
  probeEveryMs: 90_000,
  slewW: 400,
  maxChargeW: 2000,
  minChargeW: 300,
  sb3FullPct: 98,
  maxAcRoomPct: 90,
  sb3PvBridedW: 300,
  dayApsW: 200,
  cumulusOnW: 150,
  abortImportW: 150,
  abortExportW: 150,
  abortTicks: 2,
  penaltyMs: 10 * 60_000,
  sb3DrainMarginW: 250,
  fillHorizonH: 0.05,
  maxAcCapacityWh: 7200
};

export interface MaxAcLoopInputs {
  now: number;
  /** Compteur EM-50 signé : + import / − injection. */
  gridW: number;
  gridAvailable: boolean;
  /** Flux batterie Max AC signé : + décharge / − charge. */
  maxAcBattW: number;
  maxAcSocPct: number;
  maxAcAvailable: boolean;
  /** Mode lu sur l'appareil (0 = autoconsommation, 3 = contrôle par un tiers). */
  maxAcMode: number | null;
  /** SoC le plus BAS des deux SB3 (%) — le maillon faible décide. */
  sb3SocPct: number | null;
  sb3Available: boolean;
  /** PV instantané des SB3 (W, cloud). */
  sb3PvW: number;
  /** Sortie AC des SB3 (W, cloud). Comparée au PV, c'est la SEULE grandeur qui
   *  distingue « PV en transit » (ce qu'on veut récupérer) de « décharge de leur
   *  batterie » (transfert à ~15 % de pertes, qu'on refuse). Le SoC ne le dit pas. */
  sb3OutW: number;
  /** Production de l'onduleur APS (W) — témoin de jour indépendant des SB3. */
  apsW: number;
  /** Consommation du chauffe-eau (W, voie 1 de l'EM-50). `null` = voie muette,
   *  ce qui doit RENDRE LA MAIN et non valoir « pas de chauffe ». */
  cumulusW: number | null;
}

export interface MaxAcLoopState {
  /** Consigne en vigueur (W, NÉGATIVE = charge), null si on ne pilote pas. */
  setpointW: number | null;
  /** Depuis quand l'import dépasse le seuil d'abandon (ticks consécutifs). */
  importTicks: number;
  /** Fin de la mise à l'écart après abandon (epoch ms), 0 = pas de pénalité. */
  penaltyUntilTs: number;
  lastWriteTs: number | null;
  /** Dernier palier d'exploration (epoch ms). */
  lastProbeTs: number | null;
  /** Pas d'exploration courant (W) — double à chaque palier réussi, retombe au
   *  minimum dès qu'un achat apparaît. */
  probeStepW: number | null;
  lastTickTs: number | null;
  /** Journal court des dernières décisions, pour la carte et le diagnostic. */
  decisions: MaxAcDecisionLog[];
}

export interface MaxAcDecisionLog {
  ts: number;
  mode: MaxAcDecision['mode'];
  reason: string;
  gridW: number;
  setpointW: number | null;
  writtenW: number | null;
}

export interface MaxAcDecision {
  /** `idle` : on ne pilote pas et l'appareil doit être en mode 0.
   *  `enter` : entrer en mode 3 et poser la consigne de continuité.
   *  `hold`  : on pilote, rien à réécrire ce tick.
   *  `adjust`: on pilote, nouvelle consigne à écrire.
   *  `leave` : rendre la main (consigne 0 puis mode 0). */
  mode: 'idle' | 'enter' | 'hold' | 'adjust' | 'leave';
  /** Consigne à écrire (W, négative = charge), null si rien à écrire. */
  writeW: number | null;
  /** Consigne visée après ce tick (W, négative = charge). */
  targetW: number | null;
  reason: string;
  nextState: MaxAcLoopState;
}

export function emptyMaxAcState(): MaxAcLoopState {
  return {
    setpointW: null,
    importTicks: 0,
    penaltyUntilTs: 0,
    lastWriteTs: null,
    lastProbeTs: null,
    probeStepW: null,
    lastTickTs: null,
    decisions: []
  };
}
