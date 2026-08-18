/**
 * LA MAISON DE DÉMONSTRATION — modèle unique dont tout le reste découle.
 *
 * Pourquoi un modèle et pas quarante simulateurs : l'app expose 43 endpoints de
 * lecture. Les inventer un par un, c'est quarante fictions à garder cohérentes
 * entre elles — le solaire dirait 3 kW pendant que la batterie se décharge la
 * nuit. Ici, un seul état physique est calculé pour un instant donné, et chaque
 * endpoint n'en est qu'une PROJECTION (cf. projections.ts).
 *
 * DÉTERMINISTE À PARTIR DE L'HORLOGE : aucun état n'est stocké. Deux visiteurs
 * voient la même maison à la même seconde, elle évolue toute seule, et rien ne
 * dérive parce qu'il n'y a rien à faire dériver. Le pseudo-aléatoire lui-même
 * est une fonction du temps, donc reproductible.
 *
 * L'INSTALLATION EST CELLE DE LAURENT, à l'identique : mêmes coordonnées (à
 * 1 km près), même parc de batteries, même onduleur, même ballon, mêmes pièces,
 * mêmes tarifs. Seules les VALEURS sont simulées — c'est tout l'intérêt d'une
 * démo : montrer son installation sans exposer ce qui s'y passe vraiment.
 *
 * Toutes les constantes ci-dessous ont été relevées sur l'installation en
 * service (API Anker, Modbus Max AC, APsystems, config cumulus, tariffs.json),
 * jamais devinées.
 */
import { sunPosition, planeIncidenceCos } from '../cumulus/sun.ts';

// Coordonnées réelles arrondies au centième : la course du soleil est
// rigoureusement la même, sans inscrire une adresse au mètre près dans le code.
// (Relevé : latDeg 44.4792 / lonDeg -1.0835 dans la config du pilote cumulus.)
const LAT = 44.48;
const LON = -1.08;

// ── Photovoltaïque ──────────────────────────────────────────────────────
// Onduleur APsystems EZ1, 2 panneaux, plafonné à 960 W AC ; le reste des
// panneaux entre directement sur les MPPT des Solarbank. Crête calée pour
// retrouver les ~15 kWh/jour observés en août sur l'installation.
const PV_CRETE_W = 3300;
const PANNEAU_INCLINAISON = 30;
const PANNEAU_AZIMUT = 180;
/** Plafond AC de l'onduleur seul (le bridage anti-injection joue en dessous). */
const ONDULEUR_MAX_W = 960;

// ── Stockage : le parc réel ─────────────────────────────────────────────
// Anker Solix Max AC (7,1 kWh, relevée en Modbus) + 2 × Solarbank 3 E2700 Pro
// (2,7 kWh chacune, relevées sur le cloud Anker).
const BATTERIES = [
  { nom: 'Solix Max AC', modele: 'A17C5-MAX', capaciteWh: 7100 },
  { nom: 'Solarbank 3 E2700 Pro', modele: 'A17C5', capaciteWh: 2700 },
  { nom: 'Solarbank 3 E2700 Pro', modele: 'A17C5', capaciteWh: 2700 }
];
const CAPACITE_TOTALE_WH = BATTERIES.reduce((s, b) => s + b.capaciteWh, 0);
/** Sortie AC totale du parc sous bridage, jusqu'au Consuel. */
const SORTIE_AC_MAX_W = 2400;

// ── Ballon d'eau chaude ─────────────────────────────────────────────────
// Relevé dans la config de l'orchestrateur : résistance 2900 W, inertie
// 348 Wh/°C (≈ 300 L), consigne 59 °C, pertes 2,1 Wh/°C/h, arrivée d'eau 15 °C.
const BALLON_W = 2900;
const BALLON_WH_PAR_C = 348;
const BALLON_CONSIGNE_C = 59;
const BALLON_PERTE_WH_PAR_C_H = 2.1;
const EAU_FROIDE_C = 15;
/** Heures creuses réelles (tariffs.json) : 00h06 → 08h06, heure de Paris. */
const HC_DEBUT = 0.1;
const HC_FIN = 8.1;
/** Le plan de nuit vise la consigne pour 07h15 (hcEndTarget dans la config). */
const HC_CIBLE_H = 7.25;
/** Énergie d'une douche en été (eDoucheWhSummer). */
const DOUCHE_WH = 2000;

/** Pièces réellement instrumentées : 3 zones Airzone, le Séjour (Daikin),
 *  la salle de bain (sèche-serviette) et le Salon (sonde Zigbee). */
const PIECES = ['Parents', 'Amis', 'Bureau', 'Séjour', 'Salle de bain', 'Salon'] as const;
const BIAIS_PIECE: Record<string, number> = {
  Parents: -0.7,
  Amis: -0.5,
  Bureau: 0.2,
  Séjour: 0.9,
  'Salle de bain': 0.6,
  Salon: 0.7
};
const SOLAIRE_PIECE: Record<string, number> = { Séjour: 1.1, Salon: 0.9, Bureau: 0.4 };

/** Bruit lisse, déterministe, dans [-1, 1]. Trois sinusoïdes incommensurables :
 *  ça ondule sans jamais se répéter à l'œil, et sans générateur à état. */
function ondulation(t: number, periode: number, phase = 0): number {
  const x = t / periode + phase;
  return (
    (Math.sin(x * 6.283) + Math.sin(x * 2.718 * 6.283) * 0.5 + Math.sin(x * 1.414 * 6.283) * 0.3) /
    1.8
  );
}

export interface EtatMaison {
  ts: number;
  /** Hauteur du soleil en degrés (négative la nuit). */
  soleilDeg: number;
  /** Production potentielle des panneaux, avant tout bridage (W). */
  pvPotentielW: number;
  /** Production solaire totale (W). */
  pvW: number;
  /** Part passant par l'onduleur APsystems, plafonnée à 960 W (W). */
  onduleurW: number;
  /** Consommation de la maison, hors ballon d'eau chaude (W). */
  maisonW: number;
  /** Consommation du ballon (W), 0 s'il ne chauffe pas. */
  ballonW: number;
  /** Échange réseau : + soutirage, − injection (W). */
  reseauW: number;
  batterieSoc: number;
  batterieChargeW: number;
  batterieDechargeW: number;
  /** Sortie AC des batteries vers la maison (W). */
  sortieAcW: number;
  exterieurC: number;
  /** Températures par pièce. */
  pieces: Record<string, number>;
  ballonC: number;
  ballonAllume: boolean;
  /** Énergie solaire produite depuis minuit (Wh). */
  productionJourWh: number;
  /** Consommation depuis minuit (Wh). */
  consommationJourWh: number;
  cielCouvert: number;
}

// Les rythmes humains (lever, repas, soirée) et le cycle de température se
// lisent en heure FRANÇAISE, pas en heure serveur — le VPS tourne en UTC, ce qui
// décalait le pic du matin à 9 h 30 et celui du soir à 21 h 30 pour un visiteur.
// La physique solaire, elle, est déjà juste : sunPosition travaille en absolu.
const PARIS = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/** Heure décimale à Paris (0–24) pour un horodatage absolu. */
function heureParis(ts: number): number {
  const [h, m] = PARIS.format(ts).split(':').map(Number);
  return h + m / 60;
}

/** Minuit PARISIEN précédant `ts`, en ms absolus. */
function minuit(ts: number): number {
  return ts - heureParis(ts) * 3_600_000;
}

/** Production potentielle des panneaux à un instant (W). */
function productionA(ts: number): { potentiel: number; couvert: number } {
  const s = sunPosition(ts, LAT, LON);
  const cos = planeIncidenceCos(s, PANNEAU_INCLINAISON, PANNEAU_AZIMUT);
  if (cos <= 0 || s.elevationDeg <= 0) return { potentiel: 0, couvert: 0 };

  // Nébulosité VOLONTAIREMENT DISCRÈTE : une modulation trop forte déplaçait le
  // pic de production à 14 h, ce qui saute aux yeux — une courbe solaire doit
  // culminer au midi solaire, sinon la démo a l'air fausse.
  const couvert = Math.max(0, Math.min(0.35, 0.12 + ondulation(ts, 3 * 3600_000) * 0.2));
  const airMass = 1 / Math.max(0.08, Math.sin((s.elevationDeg * Math.PI) / 180));
  const clarte = Math.pow(0.75, Math.pow(airMass, 0.6));
  return { potentiel: Math.max(0, PV_CRETE_W * cos * clarte * (1 - couvert)), couvert };
}

/** Consommation de la maison hors ballon : veille + pointes + électroménager. */
function consommationA(ts: number): number {
  const h = heureParis(ts);
  const matin = 420 * Math.exp(-Math.pow((h - 7.5) / 1.1, 2));
  const soir = 780 * Math.exp(-Math.pow((h - 19.5) / 1.6, 2));
  const cycle = ondulation(ts, 47 * 60_000, 0.3) > 0.72 ? 1400 : 0;
  return Math.round(180 + matin + soir + cycle + ondulation(ts, 90_000) * 60);
}

/** Température extérieure : sinusoïde journalière + dérive saisonnière. */
function exterieurA(ts: number): number {
  const h = heureParis(ts);
  const d = new Date(ts);
  const jour = (ts - new Date(d.getFullYear(), 0, 1).getTime()) / 86_400_000;
  const saison = 14 + 9 * Math.sin(((jour - 100) / 365) * 6.283);
  return (
    Math.round(
      (saison + 6 * Math.sin(((h - 9.5) / 24) * 6.283) + ondulation(ts, 40 * 60_000) * 0.8) * 10
    ) / 10
  );
}

// ─── Intégration pas à pas ─────────────────────────────────────────────
//
// Première version : chaque grandeur avait sa formule close, indépendante des
// autres. Résultat, elles se contredisaient — la batterie « déchargeait » toute
// la nuit sans jamais se vider, et le ballon restait collé à sa borne haute.
// Un état physique ne se devine pas point par point : il s'INTÈGRE. On part de
// minuit et on avance par pas de 5 minutes ; chaque grandeur dépend de la
// précédente, donc tout reste cohérent par construction.

const PAS_MS = 5 * 60_000;
const PAS_H = PAS_MS / 3_600_000;

interface Journee {
  debut: number;
  etats: EtatMaison[];
}
const cache = new Map<number, Journee>();

function simulerJour(debut: number): Journee {
  const etats: EtatMaison[] = [];
  // Conditions au réveil : batterie entamée par la nuit précédente, ballon tiède.
  let socWh = CAPACITE_TOTALE_WH * 0.35;
  let ballonC = 42;
  let productionWh = 0;
  let consommationWh = 0;
  const capaciteWh = CAPACITE_TOTALE_WH;

  for (let i = 0; i <= Math.ceil(86_400_000 / PAS_MS); i++) {
    const ts = debut + i * PAS_MS;
    const s = sunPosition(ts, LAT, LON);
    const { potentiel, couvert } = productionA(ts);
    const maisonW = consommationA(ts);
    const exterieurC = exterieurA(ts);

    // Ballon : ne s'allume que si le surplus le couvre VRAIMENT, sinon il
    // viderait la batterie en plein soleil — ce que faisait la v1.
    const surplusAvantBallon = potentiel - maisonW;
    // Le pilote réel n'allume que sur surplus franc (surplusOnW = 2000 W dans la
    // config) et coupe à la consigne. On reproduit ce comportement, hystérésis
    // comprise, sinon le ballon clignoterait autour du seuil.
    // ── Ballon ────────────────────────────────────────────────────────
    // DEUX voies, comme en vrai. Sans la seconde, le ballon restait froid toute
    // la journée : avec 12,5 kWh de batteries à remplir et 2,3 kW de pic, le
    // surplus n'atteint presque jamais une résistance de 2,9 kW — ce que disent
    // d'ailleurs les vrais journaux (« attente de surplus »).
    //
    //   1. SOLAIRE : le pilote attend que le pack soit haut (maxAcSocOnPct 65)
    //      et laisse les batteries fournir l'appoint.
    //   2. HEURES CREUSES : plan de nuit visant la consigne pour 07h15.
    const hParis = heureParis(ts);
    const enHC = hParis >= HC_DEBUT && hParis < HC_FIN;
    const packHaut = (socWh / capaciteWh) * 100 >= 65;

    const voieSolaire =
      s.elevationDeg > 12 &&
      packHaut &&
      ((ballonC < BALLON_CONSIGNE_C - 4 && surplusAvantBallon > 400) ||
        (ballonC < BALLON_CONSIGNE_C && surplusAvantBallon > 900));

    // De nuit, on ne chauffe que ce qu'il faut pour atteindre la consigne à
    // l'heure dite : inutile de tout faire à minuit puis de perdre en pertes.
    const heuresRestantes = Math.max(0.1, HC_CIBLE_H - hParis);
    const besoinC = BALLON_CONSIGNE_C - ballonC;
    const voieHC =
      enHC && besoinC > 0.5 && besoinC * BALLON_WH_PAR_C > heuresRestantes * BALLON_W * 0.55;

    const ballonAllume = voieSolaire || voieHC;
    const ballonW = ballonAllume ? BALLON_W : 0;

    // Puisages : douches du matin et du soir. Sans elles le ballon ne
    // redescendrait jamais et la démo montrerait une courbe plate.
    const douche =
      (Math.abs(hParis - 7.6) < 0.25 ? DOUCHE_WH : 0) +
      (Math.abs(hParis - 21.2) < 0.25 ? DOUCHE_WH : 0);

    // Thermique réelle : 2900 W / 348 Wh par °C ≈ +8,3 °C/h ; pertes 2,1 Wh/°C/h
    // rapportées à l'écart avec la pièce.
    const perteC = (BALLON_PERTE_WH_PAR_C_H * (ballonC - 20)) / BALLON_WH_PAR_C;
    ballonC += ((ballonAllume ? BALLON_W : 0) / BALLON_WH_PAR_C - perteC) * PAS_H;
    // Le puisage remplace de l'eau chaude par de l'eau froide : la chute est
    // proportionnelle à l'écart avec l'arrivée d'eau.
    if (douche > 0) ballonC -= (douche / BALLON_WH_PAR_C) * (PAS_H / 0.5);
    ballonC = Math.max(EAU_FROIDE_C + 20, Math.min(BALLON_CONSIGNE_C + 1, ballonC));

    // Batterie : absorbe le surplus, soutient le déficit, dans ses bornes.
    const surplus = potentiel - maisonW - ballonW;
    let chargeW = 0;
    let dechargeW = 0;
    if (surplus > 40) chargeW = Math.min(surplus, 1200, ((capaciteWh - socWh) / PAS_H) * 1.05);
    else if (surplus < -40) dechargeW = Math.min(-surplus, SORTIE_AC_MAX_W, (socWh / PAS_H) * 0.95);
    chargeW = Math.max(0, chargeW);
    dechargeW = Math.max(0, dechargeW);
    socWh = Math.max(0, Math.min(capaciteWh, socWh + (chargeW * 0.95 - dechargeW / 0.95) * PAS_H));

    // Le réseau ferme le bilan : ce qui reste après PV et batterie.
    const reseauW = Math.round(maisonW + ballonW + chargeW - potentiel - dechargeW);

    productionWh += potentiel * PAS_H;
    consommationWh += (maisonW + ballonW) * PAS_H;

    const apport = Math.max(0, s.elevationDeg) / 90;
    const base = 21.5 + (exterieurC - 18) * 0.28;

    etats.push({
      ts,
      soleilDeg: Math.round(s.elevationDeg * 10) / 10,
      pvPotentielW: Math.round(potentiel),
      pvW: Math.round(potentiel),
      onduleurW: Math.round(Math.min(potentiel * 0.32, ONDULEUR_MAX_W)),
      maisonW,
      ballonW,
      reseauW,
      batterieSoc: Math.round((socWh / capaciteWh) * 100),
      batterieChargeW: Math.round(chargeW),
      batterieDechargeW: Math.round(dechargeW),
      sortieAcW: Math.round(dechargeW),
      exterieurC,
      // Décalages par pièce : le Séjour et le Salon prennent le soleil, les
      // chambres restent plus fraîches, la salle de bain garde la chaleur du
      // sèche-serviette.
      pieces: Object.fromEntries(
        PIECES.map((nom, i) => [
          nom,
          Math.round(
            (base +
              (BIAIS_PIECE[nom] ?? 0) +
              (SOLAIRE_PIECE[nom] ?? 0.15) * apport +
              ondulation(ts, (43 + i * 9) * 60_000, i * 0.17) * 0.25) *
              10
          ) / 10
        ])
      ) as Record<string, number>,
      ballonC: Math.round(ballonC * 10) / 10,
      ballonAllume,
      productionJourWh: Math.round(productionWh),
      consommationJourWh: Math.round(consommationWh),
      cielCouvert: Math.round(couvert * 100) / 100
    });
  }
  return { debut, etats };
}

function journee(ts: number): Journee {
  // Arrondi au pas près : `minuit` est calculé à partir d'une heure décimale,
  // deux instants du même jour doivent tomber sur la MÊME clé de cache.
  const d = Math.round(minuit(ts) / PAS_MS) * PAS_MS;
  let j = cache.get(d);
  if (!j) {
    j = simulerJour(d);
    cache.set(d, j);
    // On ne garde que quelques jours : les graphes remontent à 48 h au plus.
    if (cache.size > 4) cache.delete([...cache.keys()].sort()[0]);
  }
  return j;
}

/** État de la maison à l'instant `ts`. */
export function etatMaison(ts: number = Date.now()): EtatMaison {
  const j = journee(ts);
  const i = Math.max(0, Math.min(j.etats.length - 1, Math.floor((ts - j.debut) / PAS_MS)));
  return j.etats[i];
}

/** Série temporelle d'une grandeur, pour les graphes. */
export function serie(
  finTs: number,
  heures: number,
  pasMinutes: number,
  champ: (e: EtatMaison) => number
): Array<{ ts: number; v: number }> {
  const pts: Array<{ ts: number; v: number }> = [];
  const pas = pasMinutes * 60_000;
  for (let t = finTs - heures * 3_600_000; t <= finTs; t += pas)
    pts.push({ ts: t, v: champ(etatMaison(t)) });
  return pts;
}
