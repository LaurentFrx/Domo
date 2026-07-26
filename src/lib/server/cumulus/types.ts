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
  | 'boost' // chauffe « à la demande » (bouton Chauffer maintenant), jusqu'au plein
  | 'tank_full' // coupure mécanique détectée (ballon plein) → OFF
  | 'idle' // veille (aucun pilote actif) → OFF
  | 'observe_only' // mode observation : le pilote journalise, le relais n'est PAS commandé
  | 'anticycle_hold' // transition bloquée par l'anti-court-cycle → maintien
  | 'pilot_solar' // PILOTE V2 : chauffe solaire (règle zéro achat EDF) → ON
  | 'pilot_hc' // PILOTE V2 : recharge de fin de nuit en heures creuses → ON
  | 'pilot_wait'; // PILOTE V2 : conditions non réunies → OFF

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
  priceHp: number; // €/kWh heures pleines
  priceHc: number; // €/kWh heures creuses

  // ── Prévision PV (UNIQUEMENT pour la décision nocturne de recharge HC) ──
  forecastAvailable: boolean;
  /** Énergie PV prévue sur le prochain créneau diurne à venir (kWh). */
  solNextDaylightKwh: number;
  /** Énergie PV prévue demain (J+1), journée complète (kWh). −1 si inconnue. */
  forecastD1Kwh: number;
  /** Énergie PV prévue après-demain (J+2), journée complète (kWh). −1 si inconnue. */
  forecastD2Kwh: number;

  // ── Relais (état physique lu) ──
  relayAvailable: boolean;
  relayOn: boolean | null;

  // ── Système solaire/batterie (Anker SolarBank, cloud ~60 s de retard) ──
  // ⚠️ Conditions LENTES uniquement (batteries pleines, SoC, protection décharge).
  // JAMAIS pour une décision instantanée ; la production affichée MENT en bridage.
  ankerAvailable: boolean;
  pvPowerW: number; // production solaire AFFICHÉE (solar_power_w) — mensongère en bridage
  ankerGridPowerW: number; // réseau vu côté Anker, signé (+ soutirage / − injection)
  sbOutputPowerW: number; // sortie du système SolarBank vers la maison (W)
  batteryDischargeW: number; // puissance de décharge batterie (W, ≥ 0)
  batterySocPct: number[]; // niveau de charge de chaque batterie (%)
  batteryEnergyWh: number; // énergie stockée RÉELLE (Wh, somme des SolarBank)
  batteryCapacityWh: number; // capacité batterie totale (Wh)
  batteryChargeW: number; // puissance de CHARGE batterie (W, ≥ 0 = surplus en cours d'absorption)
  sbInputW: (number | null)[]; // PV ENTRANT par station (input_power_w) — pour la calibration de l'estimateur
  /** Charge DC des SB3 (W ≥ 0) = surplus solaire RÉORIENTABLE vers le ballon (au même
   *  titre que la charge Max AC : sous zéro-export, la SolarBank bascule de « charge »
   *  vers « sortie AC » dès que la maison demande plus). Dérivée + bornée, cf. inputs.ts. */
  sb3ChargeW: number;
  // ── Max AC en Modbus LOCAL (~2,5 s — classe « mesure locale », comme l'EM-50) ──
  // Depuis que la Max AC régule le compteur à zéro-export (boucle ~3 s avec le
  // Gen 2), le don franc a quasi disparu : le surplus vit dans SA charge. Ces
  // champs portent la voie d'allumage « saturation/réserve » du pilote (22/07).
  maxAcAvailable: boolean; // lecture Modbus locale de la Max AC disponible
  maxAcSocPct: number | null; // SoC de la Max AC (%), null si local muet
  maxAcChargeW: number | null; // puissance de CHARGE de la Max AC (W ≥ 0), null si local muet
  pvApsW: number; // prod du micro-onduleur APsystems EZ1 (pan Sud), W — l'ÉTALON (jamais bridé)
  apsAvailable: boolean; // le bridge APS répond (distinguer « injoignable » de « 0 W réel »)
  apsAgeSec: number | null; // fraîcheur de la donnée APS (s), null si inconnue

  // ── Températures ambiantes (modèle d'énergie ballon, ÉTAPE 1b+) ──
  // Moyennes des sources disponibles ; null si aucune source.
  indoorC: number | null; // moyenne des sondes intérieures (T_room de référence)
  outdoorC: number | null; // moyenne des sources extérieures
  indoorSources: TempSource[]; // sondes effectivement retenues dans la moyenne (pour le log)
  outdoorSources: TempSource[];

  // ── Gros consommateurs électriques (prises Zigbee mesurées) — pour la timeline ──
  // Journalisés (cycles nommés + effet sur le pilotage) ; le modèle ne s'appuie PAS
  // dessus pour décider (il voit déjà la conso globale via gridPowerW).
  appliances: ApplianceInput[];
}

/** Une source de température retenue dans une moyenne (nom court + valeur °C). */
export interface TempSource {
  name: string;
  tempC: number;
}

/** Instantané d'une prise électroménager mesurée (lecture MQTT côté serveur). */
export interface ApplianceInput {
  name: string; // libellé lisible (« Lave-vaisselle »)
  topic: string; // topic MQTT (clé de suivi de cycle)
  onW: number; // seuil « en marche » (W)
  powerW: number | null; // puissance instantanée (null si mesure absente/périmée)
  energyKwh: number | null; // compteur d'énergie cumulé de la prise (kWh, monotone)
}

/** Configuration (réglages) — persistée dans la section `cumulus` de settings.json. */
export interface CumulusConfig {
  /** Profil de régulation (fixe les cibles par défaut, ajustables). */
  profile: 'solar_first' | 'balanced' | 'comfort_first';

  // Températures (°C, sur la sonde de surface — voir calibration tempOffsetC)
  tminConfortC: number; // « eau au moins tiède » (sert à la détection tank_full vs panne) — plus AUCUNE chauffe automatique de confort (réponse Laurent Q1 : jamais de chauffe HP de panique)
  tmaxSondeC: number; // sécurité anti-emballement, au-dessus de la consigne du cumulus
  rechargeHysteresisC: number; // baisse de T requise pour rechauffer après « plein »
  tempOffsetC: number; // calibration sonde (T_réelle ≈ T_sonde + offset)

  // Anti-court-cycle (s)
  minOnSec: number;
  minOffSec: number;
  antiCyclingSec: number;

  // Prévision (modulation de la recharge HC uniquement)
  forecastFaibleKwh: number; // en dessous, une journée prévue est considérée « grise » (kWh)

  // Sûreté
  autoOffDelaySec: number; // watchdog Shelly (toggle_after), ré-armé à chaque tick
  tempStaleSec: number; // au-delà, la sonde est considérée périmée

  // Détection fin de chauffe / panne (via conso EM-50)
  tankFullPowerW: number; // sous cette conso (relais ON) → résistance coupée
  tankFullConfirmSec: number; // durée de confirmation « ballon plein »
  faultConfirmSec: number; // durée ON sans conso + eau froide → panne

  // ── Sécurité de déploiement ──
  /** true → le pilote tourne et JOURNALISE ses décisions, mais AUCUN ordre au relais
   *  (manuel & boost restent opérants). C'est le mode de validation de la V2. */
  observationMode: boolean;
  /** P max de décharge batterie (W) — réservé (non utilisé). */
  batteryMaxDischargeW: number;

  /** Estimateur d'énergie du ballon (calorimétrie validée — NE PAS TOUCHER). */
  energyModel: EnergyModelConfig;

  /** PILOTE V2 — machine à phases « règle zéro achat EDF » (spec validée 03/07/2026). */
  pilot: PilotConfig;
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
  drawStratFactor: number; // la sonde de point bas surlit l'amplitude des puisages (~×2,8, stratification) → énergie puisée divisée par ce facteur
  probeFullRestC: number; // sonde ≥ ce seuil, relais off → ballon considéré plein (anchor)

  // ── Discriminant de pente (relaxation post-plein vs vrai puisage, 04/07) ──
  // Une chute CONCENTRÉE sur peu de minutes est un vrai puisage (mesuré : 2-13°C en
  // ≤10 min) ; la relaxation post-plein est ~10x plus lente (~0,2-0,3°C/10min). Ce
  // seuil confirme un puisage même quand la relaxation en cours masquerait la chute
  // dans la comparaison d'intervalle. Ne remplace PAS drawDropThresholdC (inchangé).
  fastDropThresholdC: number;
  fastDropWindowMin: number;

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

/** Phase du pilote V2 (dérivée du relais réel + de l'état — jamais désynchronisée). */
export type PilotPhase =
  | 'repos' // éteint, surveillance des conditions d'allumage
  | 'allumage' // relais fermé, grâce de démarrage (latence SolarBank 2-3 min)
  | 'chauffe' // régime établi : règle zéro achat EDF stricte
  | 'cession' // coupé pour rendre la puissance à la maison (purge anti-cycle)
  | 'plein' // le thermostat mécanique a coupé
  | 'recharge_hc'; // garde-fou nocturne en heures creuses

/** Cause d'une cession — décide si la reprise compte dans le quota (réponse Laurent Q4). */
export type CessionCause =
  | 'buy' // achat réseau (électroménager/cuisine) → reprise HORS quota
  | 'hard_buy' // achat franc > cutBuyHardW → reprise HORS quota
  | 'battery' // protection batterie → reprise soumise au quota
  | 'grace_fail'; // la grâce de démarrage a échoué (nuage au départ) → quota

/** Paramètres du pilote V2 (spec du 03/07/2026, annotée par Laurent). */
export interface PilotConfig {
  // ── Allumage solaire ──
  exportOnW: number; // don franc au réseau (W) exigé pour allumer — valeur Laurent : 200
  observationBeforeOnSec: number; // les conditions doivent tenir EN CONTINU — Laurent : 180 s
  battFullPct: number; // batteries « pleines » au-dessus de ce SoC — Laurent : 98
  chargeIdleW: number; // charge résiduelle « quasi nulle » sous ce seuil (W)
  solarStartsPerDay: number; // quota d'allumages SPONTANÉS par jour (reprises après cession-achat HORS quota)
  apsMinW: number; // soleil RÉEL exigé : production APS minimale (W)
  minUsefulHeatMin: number; // jamais d'allumage s'il reste moins de X min de fenêtre devant soi
  invisibleSurplusMinW: number; // déclencheur de secours : surplus invisible estimé minimal (W)
  // ── Voie « saturation/réserve » (contexte Max AC zéro-export, 22/07/2026) ──
  surplusOnW: number; // surplus RÉORIENTABLE mesuré (charge Max AC + don) exigé pour allumer (W)
  maxAcSocOnPct: number; // réserve nocturne assurée : SoC Max AC local minimal pour céder le flux au ballon (%)

  // ── Grâce et coupures (chauffe en cours) ──
  graceStartupSec: number; // latence SolarBank tolérée au démarrage — 240 s
  cutBuyW: number; // achat réseau qui déclenche la coupure (W) — 150
  cutBuySustainSec: number; // durée d'achat soutenu avant coupure — VALEUR LAURENT : 30 s
  cutBuyHardW: number; // achat franc → coupure IMMÉDIATE (four/plaques) — 500
  batteryDropCutPts: number; // baisse de SoC depuis le début de chauffe → coupure — Laurent : 20 points
  batteryFloorCutPct: number; // plancher absolu de SoC pendant une chauffe — Laurent : 40 %

  // ── Fenêtre solaire par éphémérides (pas d'heures en dur) ──
  sunElevStartDeg: number; // début : élévation du soleil au-dessus de ce seuil…
  sunAzStartDeg: number; // … ET azimut au-delà (le pan Sud sort du masque du matin)
  sunElevEndDeg: number; // fin : élévation sous ce seuil…
  sunAzEndDeg: number; // … OU azimut au-delà (l'Ouest décroche)
  degradedWindowEndH: number; // cloud Anker muet → fin de fenêtre resserrée (heure locale)

  // ── Recharge HC de fin de nuit ──
  hcEndTarget: string; // heure visée de FIN de recharge ('07:15')
  hcPlanHour: number; // heure locale du calcul du plan nocturne (22)
  hcMorningReservePct: number; // SoC plancher pendant la recharge HC (réserve du matin) — 30
  hcGrey1Factor: number; // J+1 gris → cible = besoin × ce facteur
  hcGrey2Factor: number; // J+1 ET J+2 gris → cible = besoin × ce facteur

  // ── Alerte « APS muet » (l'étalon de TOUTE la détection solaire) ──
  apsStaleSec: number; // données APS plus vieilles → « injoignable » (fenêtre ouverte)
  apsMuteFloorW: number; // production APS sous ce seuil…
  apsMuteConfirmSec: number; // … soutenue aussi longtemps…
  apsTwinMinW: number; // … pendant que les jumeaux SB1 chargent au-dessus → « panne probable »

  // ── Divers ──
  reserveShowers: number; // douches à garantir au matin (2)
  fullFraction: number; // E_avail ≥ fullFraction × E_full → ballon considéré plein
  heatPowerW: number; // puissance de chauffe réelle (W, ~2900) — dimensionnement HC
  sb1BatteryIndex: number; // index de la station SUD dans batteries[] (calibration estimateur)
  latDeg: number; // coordonnées du site (origine : forecast-bridge)
  lonDeg: number;
}

/** État persistant du pilote (mémoire de la machine à phases). */
export interface PilotState {
  /** Depuis quand les conditions d'allumage sont TOUTES vraies (null = pas toutes vraies). */
  condsSinceTs: number | null;
  /** Depuis quand l'achat réseau dépasse cutBuyW pendant une chauffe (hors grâce). */
  buyOverSinceTs: number | null;
  /** SoC moyen au début de la chauffe en cours (protection batterie). */
  socStartOfHeat: number | null;
  /** Compteurs du jour (clé date Paris). */
  startsDate: string;
  solarStartsToday: number; // allumages spontanés (soumis au quota)
  resumesToday: number; // reprises hors quota (après cession pour achat réseau)
  /** Dernière cession : cause + horodatage (décide du quota de la reprise). */
  lastCessionCause: CessionCause | null;
  lastCessionTs: number | null;
  /** Plan de recharge HC calculé le soir (null = pas de recharge prévue). */
  hcPlan: HcPlan | null;
  /** Observation : front « j'aurais allumé » déjà journalisé (évite le spam). */
  wouldOnSinceTs: number | null;
  /** Alerte APS : depuis quand la production est anormalement basse vs jumeaux SB1. */
  apsLowSinceTs: number | null;
  /** Niveau d'alerte APS courant (fronts journalisés à l'activation/résorption). */
  apsAlert: 'none' | 'unreachable' | 'fault';
  /** Fenêtre solaire du jour (éphémérides), calculée une fois par jour calendaire
   *  et mise en cache (indépendante de l'instant courant — ne dépend que de la date). */
  sunWindow: { forDate: string; startMin: number; endMin: number } | null;
}

/** Plan de recharge nocturne calculé à hcPlanHour. */
export interface HcPlan {
  forDate: string; // date Paris du MATIN visé ('YYYY-MM-DD')
  targetWh: number; // E_avail à atteindre (besoin douches, modulé météo J+1/J+2)
  minWh: number; // besoin STRICT douches (plancher pour l'arrêt sur réserve batterie)
  startMin: number; // départ, en minutes locales depuis minuit (borné ≥ 00:06)
  endMin: number; // fin de fenêtre d'exécution (07:30 dur)
  reason: string; // explication (modulation météo appliquée)
  computedAt: number;
}

/** Vue du pilote pour l'interface (recalculée à chaque tick, persistée pour l'UI). */
export interface PilotView {
  phase: PilotPhase;
  phaseSinceTs: number;
  wantOn: boolean; // ce que le pilote FERAIT (= fait, hors observation)
  note: string; // explication de la décision courante
  conds: { key: string; label: string; ok: boolean; detail: string }[]; // les 7 conditions (le secours est À PART)
  /** Déclencheur de SECOURS (bridage) — une voie d'allumage alternative, PAS une 8e
   *  condition : jamais de ✗ rouge. */
  rescue: {
    state: 'standby_export' | 'standby_below' | 'armed' | 'unavailable';
    detail: string;
  };
  apsAlert: 'none' | 'unreachable' | 'fault'; // alerte « APS muet » (bandeau carte)
  /** Horaires de la fenêtre solaire du jour (éphémérides), 'HH:MM' ; null si aucune
   *  fenêtre ce jour (cas polaire, inatteignable à cette latitude). */
  sunWindowStart: string | null;
  sunWindowEnd: string | null;
  /** Note si la fenêtre effective est resserrée à l'exécution (cloud Anker muet). */
  sunWindowNote: string;
  invisibleSurplusW: number; // surplus invisible estimé (W)
  potTotalW: number; // potentiel solaire total estimé (W)
  pApsW: number; // production APS (l'étalon)
  socNow: number | null;
  socStart: number | null; // SoC au début de la chauffe en cours
  solarStartsToday: number;
  resumesToday: number;
  quota: number;
  nextAction: string; // « recharge HC 05:12 → 07:15 » / « attente fenêtre » / …
  computedAt: number;
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

/**
 * Échantillon du modèle SHADOW de désirabilité (page diagnostic /cumulus-labo).
 * OBSERVATION SEULE — ne pilote jamais le relais. Un point par tick.
 */
export interface DesirShadowSample {
  ts: number;
  d: number; // désirabilité D ∈ [0,1]
  wouldOn: boolean; // le modèle AURAIT chauffé (après hystérésis)
  heatingNow: boolean; // le ballon chauffe RÉELLEMENT (conso EM-50)
  relayOn: boolean; // relais réel ON
  tankRoom: number; // portail place cuve
  freeExport: number; // don franc au réseau
  freeCharge: number; // charge batterie > heater
  freeCurtail: number; // écrêtage prouvé
  freeSurplus: number; // max des trois
  solarWindow: number; // fenêtre solaire
  socPct: number; // SoC moyen parc
  socMinPct: number; // SoC du pack le moins plein
  eAvailWh: number; // énergie cuve
  gridPowerW: number; // réseau signé
  reason: string;
}

/** Évènement de la timeline — un point du journal du jour (transitions du pilote incluses). */
export type ShadowEventKind = 'phase' | 'heat_start' | 'heat_end' | 'draw' | 'full' | 'appliance';
export interface ShadowEvent {
  ts: number;
  kind: ShadowEventKind;
  label: string;
  detail: string;
}

/**
 * Boucle de REGRET (rapport §IV.6) — le système se note lui-même, en euros.
 * Accumulé au fil des ticks (décomposition MESURÉE des chauffes), clôturé par jour.
 *   - costRealEur : cash EDF réellement payé (HP + HC). L'opportunité batterie n'est
 *     PAS comptée en v1 : l'été elle se re-remplit sur de l'écrêtage qui serait perdu
 *     (coût ~0) — la compter au prix HC surestimerait le coût. Ventilation conservée
 *     pour affiner quand les profils appris arriveront.
 *   - costRefHcEur : la même énergie injectée, payée entièrement au tarif HC =
 *     stratégie de référence « tout-HC finissant 7 h » (le filet bête et fiable).
 *   - gainEur = référence − réel : ce que le pilotage a fait gagner ce jour-là.
 */
export interface RegretDay {
  date: string; // 'YYYY-MM-DD' (Paris)
  injWh: number; // énergie totale injectée dans le ballon
  pvWh: number; // part solaire (gratuite)
  battWh: number; // part batterie (autoconsommation)
  gridHpWh: number; // part EDF heures pleines
  gridHcWh: number; // part EDF heures creuses
  costRealEur: number;
  costRefHcEur: number;
  gainEur: number;
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
  /** Dernier état RÉEL du relais notifié par push (null = jamais / relais injoignable) — sert à n'émettre qu'une notif par transition allumage/extinction. */
  lastRelayNotifiedOn: boolean | null;
  /** Filet « zéro import » : depuis quand un import EDF soutenu est observé PENDANT une chauffe réelle (null = pas d'épisode en cours). */
  importDuringHeatSinceTs: number | null;
  /** Filet « zéro import » : l'épisode courant a-t-il déjà déclenché son alerte push (anti-spam, 1 par épisode). */
  importAlerted: boolean;
  lastReason: DecisionReason;
  lastSubMode: CumulusMode;
  anomaly: Anomaly;

  /** État de l'estimateur d'énergie du ballon (calorimétrie). */
  energy: EnergyState;
  /** Instantané d'affichage du modèle (lecture seule UI ; écrit par engine.ts). */
  energyView: EnergyView | null;
  /** PILOTE V2 — mémoire de la machine à phases. */
  pilot: PilotState;
  /** PILOTE V2 — vue pour l'interface (phase, conditions, potentiel, prochaine action). */
  pilotView: PilotView | null;
  /** Timeline du jour (transitions de phase, chauffes, puisages, pleins, appareils). */
  shadowLog: ShadowEvent[];
  /** Journal du modèle SHADOW de désirabilité (diagnostic /cumulus-labo ; ne pilote rien). */
  desirShadowLog: DesirShadowSample[];
  /** Suivi interne de la chauffe en cours pour la timeline (début + énergie + gratuit/réseau). */
  shadowHeat: { sinceTs: number; sinceInjWh: number; solar: boolean } | null;
  /** Cycles de gros appareils EN COURS (clé = topic MQTT) — clos → journal + retiré. */
  applianceCycles: Record<string, ApplianceCycle>;
  /** Boucle de regret : jour en cours (coûts recalculés au tick) + historique (≤ 30 j). */
  regret: { day: RegretDay; days: RegretDay[] };
  log: DecisionLogEntry[];
}

/** Cycle d'un gros appareil en cours de suivi (détection début→fin pour la timeline). */
export interface ApplianceCycle {
  running: boolean;
  startTs: number; // début du cycle (1er tick au-dessus du seuil)
  startEnergyKwh: number | null; // compteur de la prise au début (pour un kWh exact)
  energyWh: number; // intégration de secours (power×dt) si le compteur manque
  peakW: number; // pic de puissance observé
  lastAboveTs: number; // dernier tick au-dessus du seuil (fin effective + grâce)
  coHeatTicks: number; // ticks où le chauffe-eau chauffait pendant le cycle
  deferTicks: number; // ticks où le délestage 6 kVA aurait bloqué une chauffe voulue
}

/** Valeurs dérivées du modèle d'énergie, persistées pour l'UI ET la jauge du pilote. */
export interface EnergyView {
  eAvailWh: number; // énergie chaude disponible (Wh)
  eFullWh: number; // capacité à plein (Wh)
  showers: number; // nombre de douches équivalent (eAvail / eDouche)
  tTankC: number; // température moyenne estimée du ballon (°C)
  eDoucheWh: number; // énergie d'une douche (interpolation saisonnière du modèle)
  lossPerHWh: number; // pertes actuelles du ballon (Wh/h) — dimensionnement recharge HC
  /** Calibration courante de la relaxation post-plein (débogage, 04/07 — voir probe-relax-calib.ts). */
  relaxAmplitudeC: number;
  relaxTauMin: number;
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

  // ── Discriminant de pente (fenêtre courte, indépendante de drawRefC) ──
  recentProbeC: number | null; // sonde il y a ~fastDropWindowMin (référence courte, glissante)
  recentProbeTs: number | null; // horodatage de recentProbeC
  // ── Calibration de la relaxation post-plein (voir probe-relax-calib.ts) ──
  cleanSinceRef: boolean; // aucun puisage détecté depuis le dernier pic (drawRefC) → fenêtre calibrable
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
