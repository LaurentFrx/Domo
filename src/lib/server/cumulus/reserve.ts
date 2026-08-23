/**
 * RÉSERVE DU SOIR — l'énergie que le parc doit garder, exprimée en Wh et non en
 * pourcentage de SoC.
 *
 * Décision de Laurent (23/08/2026) : « je veux une réserve dynamique qui tient
 * compte de la consommation probable d'électricité entre l'heure de fin de
 * production solaire et l'heure de début des HC ». C'est la seule fenêtre où
 * l'énergie coûte cher : passé le début des heures creuses, le réseau prend le
 * relais au tarif plancher et le parc n'a plus rien à garder.
 *
 *     E_réserve = Σ profil(h) · dh  sur [fin du solaire ; début des HC]
 *
 * Mesuré sur 19 nuits complètes (22/07 → 22/08) : médiane 1 094 Wh, p90 2 281,
 * maximum 2 658, pour une fenêtre de 3,1 à 4,6 h en été. Le terme se
 * redimensionne SEUL avec la saison — coucher à 17h30 en hiver, la fenêtre
 * couvre alors les heures les plus chargées (1 554 W médians entre 18 h et 19 h
 * contre 291 W entre 21 h et 22 h) et la réserve passe à ~4 kWh sans qu'aucune
 * constante ne bouge. À comparer au plancher de 40 % qu'elle remplace, qui
 * immobilise ~5 000 Wh toute l'année, y compris à midi en plein soleil : c'est
 * lui qui a coupé la chauffe du 21/08 à 10:41 alors que le compteur INJECTAIT
 * 45 W.
 *
 * Le profil horaire est APPRIS, jamais posé : une moyenne par heure et par jour,
 * dont on prend le quantile p75 sur les jours retenus. La médiane laisserait une
 * soirée sur deux à découvert ; le p90 immobiliserait 2,3 kWh en permanence pour
 * un risque qui se solde de toute façon en heures creuses.
 */

/** Moyenne de charge maison (hors ballon) pour une heure d'un jour donné. */
export interface HouseHourSample {
  day: string; // date Paris 'YYYY-MM-DD'
  meanW: number;
}

/** 24 cases, une par heure locale ; chacune garde les derniers jours observés. */
export type HouseProfile = HouseHourSample[][];

/** Jours conservés par tranche horaire : trois semaines suffisent à couvrir un
 *  changement de saison sans traîner un profil d'une saison révolue. */
export const PROFILE_DAYS = 21;

/** Quantile du profil — seul paramètre de prudence de la réserve. */
export const PROFILE_QUANTILE = 0.75;

/**
 * Élévation solaire à laquelle la production PV s'éteint — début de la fenêtre
 * chère. MESURÉE, pas posée : sur 54 jours (01/07 → 23/08), l'élévation au
 * dernier échantillon au-dessus de 100 W a pour médiane 5,9° (p10 3,9° les jours
 * clairs, p90 13,2° les jours couverts).
 *
 * À ne PAS confondre avec la fin de la fenêtre d'ALLUMAGE du pilote, que les
 * seuils d'azimut ferment bien plus tôt : le 23/08, fenêtre close à 19h20 contre
 * une production réelle jusqu'à 20h11-20h47 les jours précédents. Prendre la
 * fenêtre d'allumage gonflait la réserve de ~1,3 kWh en lui faisant couvrir
 * l'heure de 19 h, l'une des plus chargées de la soirée (1 374 W au p75).
 */
export const PV_END_ELEVATION_DEG = 6;

export function emptyHouseProfile(): HouseProfile {
  return Array.from({ length: 24 }, () => []);
}

export function normalizeHouseProfile(raw: unknown): HouseProfile {
  const out = emptyHouseProfile();
  if (!Array.isArray(raw)) return out;
  for (let h = 0; h < 24; h++) {
    const cell = raw[h];
    if (!Array.isArray(cell)) continue;
    out[h] = cell
      .filter(
        (s): s is HouseHourSample =>
          !!s &&
          typeof (s as HouseHourSample).day === 'string' &&
          Number.isFinite((s as HouseHourSample).meanW)
      )
      .slice(-PROFILE_DAYS);
  }
  return out;
}

/** Accumulateur de l'heure en cours — persisté, sinon un redémarrage perd l'heure. */
export interface HouseAccum {
  day: string;
  hour: number;
  sumW: number;
  n: number;
}

/**
 * Intègre une mesure de charge maison hors ballon. Au changement d'heure (ou de
 * jour), la moyenne de l'heure écoulée rejoint le profil.
 *
 * `loadW` non fini est IGNORÉ — jamais compté comme 0 : une entrée manquante ne
 * doit pas faire croire à une maison silencieuse (le piège du NaN qui éteint une
 * fonction en silence a déjà coûté une voie entière du pilote).
 */
export function accumulateHouseLoad(
  profile: HouseProfile,
  accum: HouseAccum | null,
  day: string,
  hour: number,
  loadW: number | null
): { profile: HouseProfile; accum: HouseAccum | null } {
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  let next = accum;
  if (accum && (accum.day !== day || accum.hour !== h)) {
    if (accum.n > 0) {
      const cell = profile[accum.hour] ?? [];
      const meanW = accum.sumW / accum.n;
      profile[accum.hour] = [
        ...cell.filter((s) => s.day !== accum.day),
        { day: accum.day, meanW }
      ].slice(-PROFILE_DAYS);
    }
    next = null;
  }
  if (loadW === null || !Number.isFinite(loadW)) return { profile, accum: next };
  const base = next ?? { day, hour: h, sumW: 0, n: 0 };
  return {
    profile,
    accum: { day, hour: h, sumW: base.sumW + Math.max(0, loadW), n: base.n + 1 }
  };
}

/** Quantile d'une tranche horaire ; null si la tranche n'a jamais été observée. */
export function hourQuantileW(profile: HouseProfile, hour: number): number | null {
  const cell = profile[((hour % 24) + 24) % 24];
  if (!cell || cell.length === 0) return null;
  const vals = cell.map((s) => s.meanW).sort((a, b) => a - b);
  const idx = Math.min(vals.length - 1, Math.floor(PROFILE_QUANTILE * vals.length));
  return vals[idx];
}

export interface ReserveResult {
  /** Énergie à garder pour la fenêtre chère, en Wh AC. `null` = indécidable. */
  wh: number | null;
  /** Minutes de la fenêtre [fin du solaire ; début des HC]. */
  windowMin: number;
  /** Heures dont le profil manquait (comblées par la moyenne des heures connues). */
  hoursMissing: number;
  note: string;
}

/**
 * Énergie à réserver pour la fenêtre chère.
 *
 * @param minutesToSolarEnd minutes jusqu'à la fin de la fenêtre solaire (0 = le
 *        solaire est déjà fini : la fenêtre chère a commencé)
 * @param minutesToHcStart  minutes jusqu'au début des heures creuses ; `null`
 *        quand on y est déjà — la réserve vaut alors 0, l'énergie est au tarif
 *        plancher et le parc n'a plus rien à garder.
 */
export function reserveWh(
  profile: HouseProfile,
  minuteOfDay: number,
  minutesToSolarEnd: number,
  minutesToHcStart: number | null
): ReserveResult {
  if (minutesToHcStart === null) {
    return { wh: 0, windowMin: 0, hoursMissing: 0, note: 'heures creuses en cours' };
  }
  const start = Math.max(0, minutesToSolarEnd);
  const end = minutesToHcStart;
  if (end <= start) {
    return {
      wh: 0,
      windowMin: 0,
      hoursMissing: 0,
      note: 'les heures creuses arrivent avant la fin du solaire'
    };
  }
  // Moyenne des tranches connues : sert à combler une heure jamais observée
  // plutôt que de la compter pour rien.
  const known = Array.from({ length: 24 }, (_, h) => hourQuantileW(profile, h)).filter(
    (v): v is number => v !== null
  );
  if (known.length === 0) {
    return { wh: null, windowMin: end - start, hoursMissing: 24, note: 'profil maison non appris' };
  }
  const fallbackW = known.reduce((s, v) => s + v, 0) / known.length;

  let wh = 0;
  let missing = 0;
  // Intégration par pas de 15 min : plus fin que la tranche horaire du profil,
  // donc aucun palier à la frontière d'une heure.
  const STEP = 15;
  for (let m = start; m < end; m += STEP) {
    const dt = Math.min(STEP, end - m);
    const hour = Math.floor(((((minuteOfDay + m) % 1440) + 1440) % 1440) / 60);
    const q = hourQuantileW(profile, hour);
    if (q === null) missing++;
    wh += (q ?? fallbackW) * (dt / 60);
  }
  return {
    wh: Math.round(wh),
    windowMin: end - start,
    hoursMissing: missing,
    note: `${Math.round((end - start) / 6) / 10} h chères à couvrir`
  };
}
