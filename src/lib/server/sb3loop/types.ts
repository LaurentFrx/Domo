/**
 * Boucle LENTE d'allocation SB3 — types.
 *
 * Deux boucles à échelles séparées, jamais en compétition :
 *  - la Max AC asservit le compteur à zéro en SECONDES (matériel, intouchable) ;
 *  - cette boucle alloue l'énergie ENTRE batteries en MINUTES : elle pilote la
 *    consigne de décharge du SYSTÈME Solarbank 3 (2 unités, répartition interne
 *    gérée par Anker) via le cloud, avec bandes mortes larges, slew limité,
 *    bande morte en watts et repli « fail-low » (seuls amortisseurs restants).
 *
 * Asymétrie des coûts (loi de commande) : consigne SOUS la charge maison =
 * gratuit (la Max AC complète, même rendement) ; consigne AU-DESSUS = recyclage
 * SB3→Max AC (~15-20 % de pertes) ou export. On vise donc LÉGÈREMENT SOUS la
 * charge, jamais au-dessus.
 */

export interface Sb3LoopConfig {
  /** Durée pendant laquelle une correction écrite est considérée « en vol »,
   *  c'est-à-dire commandée mais pas encore reflétée par le compteur (retard
   *  d'écriture cloud + application device).
   *  ⚠ RÉGLAGE CRITIQUE, mesuré et NON majoré : un prédicteur de Smith exige une
   *  estimation JUSTE du retard. Trop long, il retranche une correction que le
   *  compteur reflète DÉJÀ et la boucle sur-corrige — observé en direct le 28/07
   *  avec 45 s (137 → 2 146 → 0 W en deux ticks). Mesure : une écriture de
   *  −1 204 W à 16:48:16 était visible au compteur au tick suivant (20 s).
   *  Donc le retard est < 1 tick et la fenêtre vaut UN tick, pas davantage.
   *  ⚠ NE PAS « réparer » avec 30 s (idée du §9.6 de l'étude) : le banc apparié
   *  du 31/07 (docs/etudes/verif_prearm_fenetre.py) la RÉFUTE — la visibilité
   *  (8-25 s) étant le plus souvent < au pas de tick, une fenêtre ≥ tick
   *  retranche des corrections DÉJÀ visibles et la boucle annule ses propres
   *  écritures en continu (achat ×4, écritures ×6 en régime saturé). */
  enVolS: number;
  /** Puissance AC max de la Max AC (W) — borne le rééquilibrage de partage :
   *  on ne déplace pas vers elle plus qu'elle ne peut fournir ou absorber.
   *  ⚠️ 800 W depuis le 10/08/2026 : Laurent a bridé sa SORTIE à 800 W en
   *  attendant le Consuel (c'était 3 540 W mesurés, p99,9 sur 18 259 points).
   *  Le bridage ne porte que sur la sortie, pas sur la charge — mais la borne
   *  reste symétrique par sûreté : sur-estimer ce que la Max AC peut reprendre
   *  crée du SOUTIRAGE (mesuré le 28/07 : un saut de −1 291 W → 867 W d'achat).
   *  🔁 REMETTRE 3600 à la levée du bridage. */
  maxAcPowerW: number;
  /** Fraction de l'écart de partage corrigée par cycle. Le rééquilibrage ENTRE
   *  batteries est un objectif de confort, pas une réponse à la maison : il ne
   *  doit pas bousculer l'équilibre du compteur que la règle 1 protège. La
   *  règle 3 (« aucune réaction différée ») porte sur la CONSOMMATION du foyer,
   *  qui est traitée à gain plein par le chemin « erreur compteur ».
   *  ⚠ La PRÉCISION du partage vaut `deadbandW / shareGain` : en deçà, le pas
   *  calculé tombe dans la bande morte et la convergence s'arrête. Avec 100 W et
   *  0,5, le partage est tenu à ±200 W — négligeable devant les 2 400 W de
   *  consigne, pour 2 à 3 écritures par rééquilibrage. */
  shareGain: number;
  /** Durée du blocage des BAISSES de consigne après un pré-armement cumulus
   *  (feedforward) : la consigne montée AVANT la fermeture du relais crée un
   *  excédent transitoire que la boucle prendrait pour une injection à
   *  corriger — elle annulerait le pré-armement juste avant l'échelon. Les
   *  MONTÉES restent libres (règle 1 intouchée). Vérifié par le banc apparié
   *  du 31/07 (docs/etudes/verif_prearm_fenetre.py). */
  ffHoldS: number;
  /** RÈGLE 0 — rééquilibrage de CHARGE. Écart de remplissage relatif au-delà
   *  duquel on détourne le PV des SB3 vers la Max AC. Bande d'hystérésis : en
   *  deçà on ne touche à rien (le détour coûte une conversion de plus). */
  rebalanceBandFrac: number;
  /** Fraction du PV détournable corrigée par cycle (même rôle que shareGain). */
  rebalanceGain: number;
  /** Réserve intouchable de chaque batterie (%) : l'énergie « utilisable » qui
   *  sert au prorata s'entend RÉSERVE DÉDUITE. Règle Laurent 28/07. */
  reservePct: number;
  /** Palier de repli quand le cloud est périmé — SEUL palier subsistant : c'est
   *  une dégradation de sûreté (on ne connaît plus la charge), pas une réponse. */
  failLowStepW: number;
  /** Bande morte : écart minimal pour envisager une écriture (W).
   *  DOIT rester < marginW, sinon la cible « charge − marge » tombe dans la
   *  bande et une consigne trop haute ne redescend jamais (revue 23/07). */
  deadbandW: number;
  /** Dwell dédié des paliers fail-low (s) — évite un login cloud par minute. */
  failLowDwellS: number;
  /** Après une écriture, le sb3Out cloud est périmé : pendant ce délai on lui
   *  substitue la consigne écrite (le device applique en secondes). */
  settleS: number;
  /** Consigne maximale système (W) — garde-fou (le bridge borne aussi). */
  maxPresetW: number;
  /** Fraîcheur cloud au-delà de laquelle house_load n'est plus fiable (s). */
  cloudStaleS: number;
  /** Silence EM-50/Modbus au-delà duquel AUCUNE écriture (s). */
  localMuteS: number;
  /** Écritures non confirmées consécutives avant auto-désactivation. */
  confirmFailMax: number;
  /** Tentatives de restauration du plan statique avant abandon + notification.
   *  Réarmé chaque jour Paris : un échec nocturne ne doit pas condamner la
   *  restauration du lendemain. */
  restoreAttemptsMax: number;
  /** Tolérance de confirmation (W) — step device 5-10 W + arrondis lib. */
  confirmToleranceW: number;
  /** Plan statique de référence (les créneaux posés dans l'app) : la valeur à
   *  RESTAURER dans le créneau courant à l'arrêt de la boucle — l'écriture
   *  cloud modifie le créneau pour les 7 jours (entrée unique du plan), rien
   *  ne le restaure tout seul. */
  staticNightW: number;
  staticDayW: number;
  staticNightStartH: number; // 19 → créneau nuit 19:00 → 07:00
  staticNightEndH: number;
  /** Éphémérides (jour/nuit par élévation solaire). */
  latDeg: number;
  lonDeg: number;
}

/** Entrées d'un cycle de décision — collectées par inputs.ts, toutes datées. */
export interface Sb3LoopInputs {
  now: number;
  /** EM-50 : réseau signé (+ achat / − injection). Vérité compteur. */
  em50: { ok: boolean; gridW: number };
  /** APS EZ1 : production (≈ 0 la nuit — 0 réel, pas une panne). */
  aps: { ok: boolean; powerW: number };
  /** Max AC en Modbus local : SoC + flux AC net (+ décharge / − charge) +
   *  capacité nominale (pour le prorata d'énergie utilisable). */
  maxac: { ok: boolean; socPct: number; acNetW: number; ratedEnergyWh: number };
  /** Cloud Anker (bridge) : le système SB3 seul. */
  cloud: {
    ok: boolean;
    freshS: number | null;
    sb3OutW: number | null;
    sb3SocAvg: number | null;
    /** Détail par pack SB3 : le prorata se calcule sur l'énergie utilisable de
     *  CHACUN, pas sur une moyenne (deux packs identiques peuvent diverger). */
    sb3Packs: { socPct: number; capacityWh: number }[];
    sb3PresetW: number | null;
    /** PV DC total entrant dans les SB3 (W) — ce qu'elles peuvent DÉTOURNER vers
     *  le bus AC en montant la consigne. Sans lui, la règle 0 est aveugle. */
    sb3PvW: number | null;
    sceneMode: number | null;
  };
  /** Élévation solaire (°) — sun.ts, lat/lon de la config. */
  sunElevDeg: number;
}

export type Sb3LoopMode = 'off' | 'failsafe' | 'faillow' | 'allocate' | 'hold';

/** Créneau du plan statique posé dans l'app Anker. Une écriture cloud ne
 *  modifie QUE l'entrée couvrant l'heure locale courante : restaurer le créneau
 *  jour exige d'écrire pendant le jour, et réciproquement. */
export type Sb3PlanSlot = 'day' | 'night';

export interface Sb3Decision {
  /** Consigne à écrire (W), ou null si aucune écriture ce cycle. */
  writeW: number | null;
  /** Cible calculée avant bande morte (pour le journal/l'UI). */
  targetW: number | null;
  mode: Sb3LoopMode;
  /** Cause humaine de la décision (journal + tuile). */
  reason: string;
  /** house_load estimée (W), null si inconnue. */
  houseLoadW: number | null;
  /** Nouvelle file des corrections en vol (persistée). */
  enVol: { ts: number; dW: number }[];
}

export interface Sb3DecisionLogEntry {
  ts: number;
  mode: Sb3LoopMode;
  reason: string;
  houseLoadW: number | null;
  targetW: number | null;
  /** Consigne en place avant / écrite après (null si pas d'écriture). */
  beforeW: number | null;
  writtenW: number | null;
  confirmedW: number | null;
}

/** État persistant (atomic-store, data/sb3loop-state.json). */
export interface Sb3LoopState {
  /** Interrupteur utilisateur (tuile). */
  enabled: boolean;
  /** Raison d'une auto-désactivation (écritures non prises, canary…). */
  autoDisabledReason: string | null;
  autoDisabledTs: number | null;
  /** Corrections COMMANDÉES mais pas encore visibles au compteur (prédicteur de
   *  Smith) : {ts, deltaW}. Sans elles la boucle compte deux fois la même
   *  correction et entre en cycle limite (docs/regulation-energie.md §3-4). */
  enVol: { ts: number; dW: number }[];
  /** Jusqu'à cet instant, les BAISSES de consigne sont suspendues : un
   *  pré-armement cumulus vient de monter la consigne AVANT l'échelon de
   *  charge — l'excédent que voit le compteur est voulu et éphémère. */
  ffHoldUntilTs: number | null;
  /** Dernière consigne ÉCRITE par la boucle (ancrage du slew). */
  lastCmdW: number | null;
  lastWriteTs: number | null;
  /** Écritures non confirmées consécutives. */
  confirmFailCount: number;
  lastTickTs: number | null;
  /** Tentatives de restauration du plan statique après arrêt (bornées à 3). */
  restoreAttempts: number;
  /** Créneaux du plan que la boucle a MODIFIÉS et qui restent à restaurer.
   *  Marqué à la TENTATIVE d'écriture, pas à sa confirmation : une écriture non
   *  confirmée peut avoir été appliquée côté cloud (la confirmation est une
   *  relecture, elle échoue aussi sur timeout ou créneau traversant minuit).
   *  Vidé créneau par créneau, chacun quand il redevient le créneau courant. */
  pendingRestoreSlots: Sb3PlanSlot[];
  /** Canary schéma + check version lib : une fois par jour Paris. */
  lastCanaryDayParis: string | null;
  lastVersionCheckDayParis: string | null;
  /** Journal des décisions (ring, plus récentes en tête). */
  decisions: Sb3DecisionLogEntry[];
}

export function defaultSb3LoopState(): Sb3LoopState {
  return {
    enabled: false, // JAMAIS actif par défaut — activation explicite (tuile)
    autoDisabledReason: null,
    autoDisabledTs: null,
    enVol: [],
    ffHoldUntilTs: null,
    lastCmdW: null,
    lastWriteTs: null,
    confirmFailCount: 0,
    lastTickTs: null,
    restoreAttempts: 0,
    pendingRestoreSlots: [],
    lastCanaryDayParis: null,
    lastVersionCheckDayParis: null,
    decisions: []
  };
}

/** Défauts : les valeurs de la spec, aucune agressivité. */
export function defaultSb3LoopConfig(): Sb3LoopConfig {
  return {
    reservePct: 10,
    enVolS: 20,
    ffHoldS: 30,
    maxAcPowerW: 800,
    shareGain: 0.5,
    rebalanceBandFrac: 0.1,
    rebalanceGain: 0.5,
    failLowStepW: 300,
    deadbandW: 100, // < marginW — sinon la cible « charge − marge » est piégée dans la bande
    failLowDwellS: 300,
    settleS: 180,
    // Consigne système SB3 : 2 × 800 W depuis le bridage Consuel (c'était 2 × 1 200).
    // 🔁 REMETTRE 2400 à la levée du bridage.
    maxPresetW: 1600,
    cloudStaleS: 180,
    localMuteS: 120,
    confirmFailMax: 2,
    restoreAttemptsMax: 3,
    confirmToleranceW: 25,
    staticNightW: 300,
    staticDayW: 0,
    staticNightStartH: 19,
    staticNightEndH: 7,
    latDeg: 44.4792,
    lonDeg: -1.0835
  };
}
