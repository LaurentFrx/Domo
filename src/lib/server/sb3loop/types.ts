/**
 * Boucle LENTE d'allocation SB3 — types.
 *
 * Deux boucles à échelles séparées, jamais en compétition :
 *  - la Max AC asservit le compteur à zéro en SECONDES (matériel, intouchable) ;
 *  - cette boucle alloue l'énergie ENTRE batteries en MINUTES : elle pilote la
 *    consigne de décharge du SYSTÈME Solarbank 3 (2 unités, répartition interne
 *    gérée par Anker) via le cloud, avec bandes mortes larges, slew limité,
 *    dwell entre écritures et biais « fail-low ».
 *
 * Asymétrie des coûts (loi de commande) : consigne SOUS la charge maison =
 * gratuit (la Max AC complète, même rendement) ; consigne AU-DESSUS = recyclage
 * SB3→Max AC (~15-20 % de pertes) ou export. On vise donc LÉGÈREMENT SOUS la
 * charge, jamais au-dessus.
 */

export interface Sb3LoopConfig {
  /** Marge sous la charge maison (W) — la Max AC couvre marge et pointes. */
  marginW: number;
  /** Pas maximal d'évolution de la consigne par cycle (W). */
  slewW: number;
  /** Bande morte : écart minimal pour envisager une écriture (W).
   *  DOIT rester < marginW, sinon la cible « charge − marge » tombe dans la
   *  bande et une consigne trop haute ne redescend jamais (revue 23/07). */
  deadbandW: number;
  /** Évaluations consécutives hors bande (MÊME direction) avant d'écrire. */
  deadbandEvals: number;
  /** Délai minimal entre écritures en HAUSSE (s). */
  dwellUpS: number;
  /** Délai minimal entre écritures en BAISSE (s) — « écritures ≥ 60 s ». */
  dwellDownS: number;
  /** Dwell dédié des paliers fail-low (s) — évite un login cloud par minute. */
  failLowDwellS: number;
  /** Après une écriture, le sb3Out cloud est périmé : pendant ce délai on lui
   *  substitue la consigne écrite (le device applique en secondes). */
  settleS: number;
  /** Production APS au-delà de laquelle c'est « le jour » (W). */
  dayApsW: number;
  /** SoC SB3 sous lequel, soleil levé, elles doivent charger (pas décharger). */
  daySocPct: number;
  /** Garde : SoC SB3 sous lequel on ne demande plus rien (réserve firmware 10 %). */
  sb3FloorPct: number;
  /** Exception « rescue » : Max AC sous ce SoC + SB3 chargées → suivre la charge même de jour. */
  maxAcMinPct: number;
  /** SoC SB3 minimal pour armer le rescue. */
  rescueSb3MinPct: number;
  /** Rescue : la Max AC doit RÉELLEMENT se vider (décharge AC > ce seuil, W).
   *  Une Max AC basse mais EN CHARGE (surplus solaire) n'est PAS en danger —
   *  la "secourir" draine les SB3 qui devraient charger (incident 23/07). */
  rescueMaxAcDischargeW: number;
  /** Consigne maximale système (W) — garde-fou (le bridge borne aussi). */
  maxPresetW: number;
  /** Fraîcheur cloud au-delà de laquelle house_load n'est plus fiable (s). */
  cloudStaleS: number;
  /** Silence EM-50/Modbus au-delà duquel AUCUNE écriture (s). */
  localMuteS: number;
  /** Écritures non confirmées consécutives avant auto-désactivation. */
  confirmFailMax: number;
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
  /** Max AC en Modbus local : SoC + flux AC net (+ décharge / − charge). */
  maxac: { ok: boolean; socPct: number; acNetW: number };
  /** Cloud Anker (bridge) : le système SB3 seul. */
  cloud: {
    ok: boolean;
    freshS: number | null;
    sb3OutW: number | null;
    sb3SocAvg: number | null;
    sb3PresetW: number | null;
    sceneMode: number | null;
  };
  /** Élévation solaire (°) — sun.ts, lat/lon de la config. */
  sunElevDeg: number;
}

export type Sb3LoopMode = 'off' | 'failsafe' | 'faillow' | 'day' | 'night' | 'rescue' | 'hold';

export interface Sb3Decision {
  /** Consigne à écrire (W), ou null si aucune écriture ce cycle. */
  writeW: number | null;
  /** Cible calculée avant bande morte/dwell (pour le journal/l'UI). */
  targetW: number | null;
  mode: Sb3LoopMode;
  /** Cause humaine de la décision (journal + tuile). */
  reason: string;
  /** house_load estimée (W), null si inconnue. */
  houseLoadW: number | null;
  /** Nouveau compteur de bande morte (persisté). */
  pendingDeadband: number;
  /** Direction de l'excursion en cours (persistée avec le compteur). */
  pendingDeadbandDir: 'up' | 'down' | null;
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
  /** Dernière consigne ÉCRITE par la boucle (ancrage du slew). */
  lastCmdW: number | null;
  lastWriteTs: number | null;
  /** Écritures non confirmées consécutives. */
  confirmFailCount: number;
  /** Évaluations consécutives hors bande morte (même direction). */
  pendingDeadband: number;
  /** Direction de l'excursion en cours ('up'/'down') — un changement de
   *  direction remet le compteur à 1 (revue 23/07). */
  pendingDeadbandDir: 'up' | 'down' | null;
  lastTickTs: number | null;
  /** Tentatives de restauration du plan statique après arrêt (bornées à 3). */
  restoreAttempts: number;
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
    lastCmdW: null,
    lastWriteTs: null,
    confirmFailCount: 0,
    pendingDeadband: 0,
    pendingDeadbandDir: null,
    lastTickTs: null,
    restoreAttempts: 0,
    lastCanaryDayParis: null,
    lastVersionCheckDayParis: null,
    decisions: []
  };
}

/** Défauts : les valeurs de la spec, aucune agressivité. */
export function defaultSb3LoopConfig(): Sb3LoopConfig {
  return {
    marginW: 150,
    slewW: 300,
    deadbandW: 100, // < marginW — sinon la cible « charge − marge » est piégée dans la bande
    deadbandEvals: 2,
    dwellUpS: 300,
    dwellDownS: 120,
    failLowDwellS: 300,
    settleS: 180,
    dayApsW: 100,
    daySocPct: 97,
    sb3FloorPct: 15,
    maxAcMinPct: 40,
    rescueSb3MinPct: 30,
    rescueMaxAcDischargeW: 200,
    maxPresetW: 2400,
    cloudStaleS: 180,
    localMuteS: 120,
    confirmFailMax: 2,
    confirmToleranceW: 25,
    staticNightW: 300,
    staticDayW: 0,
    staticNightStartH: 19,
    staticNightEndH: 7,
    latDeg: 44.4792,
    lonDeg: -1.0835
  };
}
