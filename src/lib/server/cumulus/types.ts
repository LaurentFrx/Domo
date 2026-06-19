/**
 * Orchestrateur cumulus — types partagés (moteur, état, config).
 *
 * Le moteur est scindé en deux :
 *   - `decide(inputs, config, state)` : PUR (aucune I/O), testable — voir decide.ts
 *   - `tick()` : impur (collecte des entrées, application relais, persistance) — engine.ts
 *
 * Toutes les entrées du moteur (y compris `isHC`, la date Paris, les délais de
 * bascule tarifaire) sont pré-calculées dans `inputs.ts` et passées à `decide()`
 * pour que celui-ci reste une fonction pure de ses arguments.
 */

import type { CumulusMode } from '$theme/tokens';

/** Mode de pilotage choisi par l'utilisateur (persistant). */
export type AutoMode = 'auto' | 'manual' | 'off';

/** Raison de la décision courante — pilote l'affichage et la couleur UI. */
export type DecisionReason =
  | 'cold_start' // entrées insuffisantes (boot) → aucun ordre
  | 'manual_on' // mode manuel, relais forcé ON
  | 'manual_off' // mode manuel, relais forcé OFF
  | 'vacation_off' // mode off (vacances) → OFF
  | 'safety_high' // T ≥ Tmax (sonde) → OFF impératif
  | 'comfort_min' // T < Tmin → ON garanti (filet famille)
  | 'boost' // chauffe « à la demande » (bouton Chauffer maintenant), jusqu'au plein
  | 'legionella' // cycle anti-légionellose → ON
  | 'solar' // surplus PV → ON
  | 'offpeak' // heures creuses (cible de base) → ON
  | 'offpeak_boost' // heures creuses (cible renfort, peu de soleil demain) → ON
  | 'tank_full' // coupure mécanique détectée (ballon plein) → OFF
  | 'idle' // veille : ni surplus, ni HC → OFF
  | 'observe_only' // mode observation : chauffe AUTO neutralisée (collecte seule, ÉTAPE 1a)
  | 'anticycle_hold'; // transition bloquée par l'anti-court-cycle → maintien

/** Anomalie détectée (visible dans l'UI, non bloquante sauf heater_fault). */
export type Anomaly =
  | 'none'
  | 'relay_unreachable' // le Shelly ne répond pas
  | 'sensor_stale' // la sonde de température est périmée/absente
  | 'desync' // état logique ≠ état physique lu
  | 'heater_fault'; // commandé ON depuis longtemps, aucune conso, eau froide

/**
 * Entrées d'un tick — toutes pré-calculées et « pures » pour `decide()`.
 * Chaque source porte sa disponibilité/fraîcheur pour un repli prudent.
 */
export interface CumulusInputs {
  /** Horodatage du tick (epoch ms). */
  now: number;
  /** Date locale Paris 'YYYY-MM-DD' (clé du compteur d'énergie du jour). */
  todayParis: string;

  // ── Température eau (sonde Zigbee thermo_cumulus, lue côté serveur) ──
  /** Température corrigée de l'offset (°C), ou null si inconnue/périmée. */
  tempC: number | null;
  /** Âge de la dernière mesure (ms), ou null si jamais reçue. */
  tempAgeMs: number | null;

  // ── Réseau & conso cumulus (Shelly EM-50) ──
  em50Available: boolean;
  /** Puissance réseau signée : + soutirage EDF / − injection PV (W). */
  gridPowerW: number;
  /** Conso cumulus mesurée (W, ≥ 0). */
  cumulusPowerW: number;
  /** Compteur cumulatif conso cumulus (kWh, monotone). */
  cumulusKwh: number;

  // ── Tarif HP/HC ──
  isHC: boolean;
  /** Minutes avant la fin de la fenêtre HC (si en HC), sinon -1. */
  minutesToHcEnd: number;

  // ── Prévision PV ──
  forecastAvailable: boolean;
  /** Énergie PV prévue sur le prochain créneau diurne à venir (kWh). */
  solNextDaylightKwh: number;

  // ── Relais (état physique lu) ──
  relayAvailable: boolean;
  relayOn: boolean | null;

  // ── Système solaire/batterie (Anker SolarBank) — COLLECTE seule (ÉTAPE 1a) ──
  // Aucune décision ne s'appuie dessus pour l'instant ; journalisées à chaque tick.
  ankerAvailable: boolean;
  pvPowerW: number; // production solaire instantanée (solar_power_w)
  ankerGridPowerW: number; // réseau vu côté Anker, signé (+ soutirage / − injection)
  sbOutputPowerW: number; // sortie du système SolarBank vers la maison (W)
  batteryDischargeW: number; // puissance de décharge batterie (W, ≥ 0)
  batterySocPct: number[]; // niveau de charge de chaque batterie (%)

  // ── Températures ambiantes (modèle d'énergie ballon, ÉTAPE 1b+) ──
  // Moyennes des sources disponibles ; null si aucune source.
  indoorC: number | null; // moyenne des sondes intérieures (T_room de référence)
  outdoorC: number | null; // moyenne des sources extérieures
  indoorSources: TempSource[]; // sondes effectivement retenues dans la moyenne (pour le log)
  outdoorSources: TempSource[];
}

/** Une source de température retenue dans une moyenne (nom court + valeur °C). */
export interface TempSource {
  name: string;
  tempC: number;
}

/** Configuration (réglages) — persistée dans la section `cumulus` de settings.json. */
export interface CumulusConfig {
  /** Profil de régulation (fixe les cibles par défaut, ajustables). */
  profile: 'solar_first' | 'balanced' | 'comfort_first';

  // Températures (°C, sur la sonde de surface — voir calibration tempOffsetC)
  tminConfortC: number; // sous ce seuil → chauffe garantie (filet, en tout temps)
  tmaxSondeC: number; // sécurité anti-emballement, au-dessus de la consigne du cumulus
  comfortHysteresisC: number; // marge au-dessus de Tmin avant de couper « confort »
  rechargeHysteresisC: number; // baisse de T requise pour rechauffer après « plein »
  tempOffsetC: number; // calibration sonde (T_réelle ≈ T_sonde + offset)

  // Surplus PV (W) — décision sur le surplus reconstitué = cumulusPowerW − gridPowerW
  surplusOnW: number; // seuil d'enclenchement
  surplusOffW: number; // seuil de maintien (hystérésis)
  surplusOffGraceSec: number; // tolérance sous le seuil avant coupure (anti-nuage)

  // Anti-court-cycle (s)
  minOnSec: number;
  minOffSec: number;
  antiCyclingSec: number;

  // Prévision
  forecastFaibleKwh: number; // sous ce seuil → cible HC renfort

  // Sûreté
  autoOffDelaySec: number; // watchdog Shelly (toggle_after), ré-armé à chaque tick
  tempStaleSec: number; // au-delà, la sonde est considérée périmée

  // Détection fin de chauffe / panne (via conso EM-50)
  tankFullPowerW: number; // sous cette conso (relais ON) → résistance coupée
  tankFullConfirmSec: number; // durée de confirmation « ballon plein »
  faultConfirmSec: number; // durée ON sans conso + eau froide → panne

  // ── ÉTAPE 1a — sécurité (observation) & réserve pour la reconstruction ──
  /** true → AUCUNE chauffe AUTOMATIQUE (comfort/solar/HC) ; manuel & boost intacts. */
  observationMode: boolean;
  /** P max de décharge batterie (W) — réservé au futur réflexe de délestage (non utilisé). */
  batteryMaxDischargeW: number;

  /** ÉTAPE 1b — estimateur d'énergie du ballon (observation, ne pilote rien). */
  energyModel: EnergyModelConfig;
}

/**
 * Paramètres du modèle d'énergie du ballon (ÉTAPE 1b — observation pure).
 * Valeurs de départ « été », toutes à calibrer. `T_inlet`, `roomOffset` et
 * `eDouche` sont interpolés entre hiver et été selon la température extérieure.
 */
export interface EnergyModelConfig {
  etaHeat: number; // rendement de chauffe (injecté / consommé)
  tankWhPerC: number; // capacité thermique du ballon (Wh par °C) — 300 L → ~348
  setpointC: number; // température de coupure observée du thermostat (= ballon plein)
  inletSummerC: number; // temp eau froide d'arrivée en été
  inletWinterC: number; // temp eau froide d'arrivée en hiver
  outdoorWinterC: number; // borne basse d'interpolation saisonnière (temp ext.)
  outdoorSummerC: number; // borne haute d'interpolation saisonnière (temp ext.)
  outdoorFallbackC: number; // temp ext. de repli si forecast indispo
  roomOffsetSummerC: number; // T_room = T_indoor − offset ; été
  roomOffsetWinterC: number; // … hiver
  roomFallbackC: number; // T_room de repli si sonde intérieure indispo
  lossCoeffWhPerCh: number; // pertes : Wh/h par °C d'écart (T_tank − T_room)
  eDoucheWhSummer: number; // énergie d'une douche en été (Wh)
  eDoucheWhWinter: number; // … hiver
  drawDropThresholdC: number; // chute sonde (au-delà des pertes) sur la fenêtre → puisage
  drawWindowMin: number; // fenêtre glissante de détection de puisage (minutes, sonde lente)
  probeFullRestC: number; // sonde ≥ ce seuil, relais off → ballon considéré plein (anchor)

  // Sources de température de référence (moyennées) — configurables.
  indoorTopics: string[]; // sondes intérieures MQTT (T_room) à moyenner
  outdoorSources: OutdoorSourcesConfig; // sources de temp extérieure à moyenner
}

/** Sources de température extérieure (moyennées si disponibles). */
export interface OutdoorSourcesConfig {
  daikin: boolean; // temp ext. du bridge Daikin (:8096)
  thermoExtTopic: string; // sonde MQTT extérieure (terrasse) ; '' pour désactiver
  forecast: boolean; // temp horaire du provider météo (:8098)
}

/** Une entrée du journal de décisions (ring buffer). */
export interface DecisionLogEntry {
  ts: number;
  reason: DecisionReason;
  relayDesired: boolean;
  tempC: number | null;
  surplusW: number;
  cumulusPowerW: number;
  isHC: boolean;
  anomaly: Anomaly;
}

/** État runtime persistant (data/cumulus-state.json). */
export interface CumulusRuntimeState {
  autoMode: AutoMode;
  /** État voulu en mode manuel. */
  manualRelayOn: boolean;
  /** Chauffe « à la demande » en cours, jusqu'au plein (puis retour auto). */
  boostUntilFull: boolean;
  /** Dernier ordre émis par le moteur (null avant le 1er). */
  relayDesired: boolean | null;

  // Anti-court-cycle
  lastOnTs: number | null;
  lastOffTs: number | null;
  lastTransitionTs: number | null;

  // Hystérésis surplus (grâce anti-nuage)
  surplusBelowSinceTs: number | null;

  // Fin de chauffe / niveau de charge
  lowPowerSinceTs: number | null;
  ballonCharged: boolean;
  chargedAtTempC: number | null;

  /** Depuis quand le relais est physiquement ON en continu. */
  onSinceTs: number | null;

  // Énergie du jour (delta du compteur cumulatif EM-50)
  energyDayDate: string;
  energyTodayKwh: number;
  lastCumulusKwh: number | null;

  // Désinfection : dernière fois que le ballon a atteint ≥60°C (chauffe complète)
  lastDisinfectTs: number | null;

  // Heartbeat / UI
  lastTickTs: number | null;
  /** Dernière température d'eau vue par le moteur (null si sonde périmée). */
  lastTempC: number | null;
  lastReason: DecisionReason;
  lastSubMode: CumulusMode;
  anomaly: Anomaly;

  /** ÉTAPE 1b — état de l'estimateur d'énergie du ballon (observation). */
  energy: EnergyState;
  /** Instantané d'affichage du modèle (lecture seule UI ; écrit par engine.ts). */
  energyView: EnergyView | null;
  log: DecisionLogEntry[];
}

/** Valeurs dérivées du modèle d'énergie, persistées pour l'UI (carte Cumulus). */
export interface EnergyView {
  eAvailWh: number; // énergie chaude disponible (Wh)
  eFullWh: number; // capacité à plein (Wh)
  showers: number; // nombre de douches équivalent (eAvail / eDouche)
  tTankC: number; // température moyenne estimée du ballon (°C)
}

/** État runtime de l'estimateur d'énergie du ballon (persisté dans cumulus-state.json). */
export interface EnergyState {
  eAvailWh: number; // énergie chaude estimée disponible (Wh)
  lastUpdateTs: number | null; // dernier tick traité (base du Δt)
  lastProbeC: number | null; // dernière valeur DISTINCTE de la sonde eau (point bas)
  lastProbeTs: number | null; // horodatage de lastProbeC
  lastAnchorTs: number | null; // dernier recalage « ballon plein » (vérité primaire)
  dayDate: string; // clé Paris des composantes cumulées du jour
  injWhDay: number; // énergie injectée cumulée du jour (Wh)
  lossWhDay: number; // pertes cumulées du jour (Wh)
  drawWhDay: number; // énergie puisée cumulée du jour (Wh)
  drawEvents: number; // nombre d'événements de puisage du jour
  wasFull: boolean; // ballon plein au tick précédent (front montant de lastAnchorTs)
  drawRefC: number | null; // référence « point haut » de la détection par fenêtre glissante
  drawRefTs: number | null; // horodatage de drawRefC
  tRoomC: number | null; // moyenne intérieure du tick (historisée pour calibrer lossCoeff)
  tExtC: number | null; // moyenne extérieure du tick (historisée)
}

/** Résultat de `decide()` — décision + nouvel état à persister (pattern reducer pur). */
export interface Decision {
  /** Relais voulu (ON/OFF). */
  relayDesired: boolean;
  reason: DecisionReason;
  /** Sous-mode pour la couleur/affichage UI. */
  subMode: CumulusMode;
  anomaly: Anomaly;
  /** Surplus PV reconstitué au moment de la décision (W). */
  surplusW: number;
  /** Texte court d'explication (ex. « surplus 2100 W »). */
  note: string;
  /** Émettre réellement l'ordre ? false en cold-start / relais injoignable. */
  apply: boolean;
  /** Nouvel état runtime (à persister par tick()). */
  nextState: CumulusRuntimeState;
}
