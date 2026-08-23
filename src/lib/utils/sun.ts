/**
 * Position solaire — algorithme NOAA (Solar Position Algorithm simplifié), TS pur.
 *
 * Sert deux usages du pilote V2 :
 *   1. la FENÊTRE SOLAIRE dérivée chaque jour des éphémérides (élévation + azimut)
 *      au lieu d'heures en dur — elle suit naturellement les saisons ;
 *   2. la GÉOMÉTRIE d'incidence sur les deux plans de panneaux (Sud 190°/20°,
 *      Ouest ~270°/20°) pour l'estimateur de potentiel (transposition Sud→Ouest).
 *
 * Précision ~0,01° sur l'élévation — largement suffisant (les seuils sont à ±1°).
 * Aucune dépendance. Coordonnées : lues de la config (origine forecast-bridge).
 *
 * Module PARTAGÉ client/serveur (déplacé de `server/cumulus/sun.ts` le
 * 23/08/2026) : la carte Store l'utilise pour placer les ombres de la terrasse.
 */

/** Sanguinet — mêmes coordonnées que la config du pilote cumulus. */
export const HOME_LAT = 44.4792;
export const HOME_LON = -1.0835;

export interface SunPosition {
  elevationDeg: number; // hauteur au-dessus de l'horizon (négatif = sous l'horizon)
  azimuthDeg: number; // 0 = Nord, 90 = Est, 180 = Sud, 270 = Ouest
}

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Position du soleil à l'instant `ts` (epoch ms) pour lat/lon en degrés. */
export function sunPosition(ts: number, latDeg: number, lonDeg: number): SunPosition {
  // Jour julien (temps universel)
  const jd = ts / 86_400_000 + 2440587.5;
  const t = (jd - 2451545) / 36525; // siècles juliens depuis J2000

  // Longitude moyenne, anomalie moyenne (deg)
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const mr = rad(m);

  // Équation du centre → longitude vraie
  const c =
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289;
  const trueLon = l0 + c;

  // Longitude apparente (nutation approx.)
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLon - 0.00569 - 0.00478 * Math.sin(rad(omega));

  // Obliquité de l'écliptique (corrigée)
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));

  // Déclinaison
  const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));

  // Équation du temps (minutes)
  const y = Math.tan(rad(eps / 2)) ** 2;
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t); // excentricité
  const l0r = rad(l0);
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * l0r) -
        2 * e * Math.sin(mr) +
        4 * e * y * Math.sin(mr) * Math.cos(2 * l0r) -
        0.5 * y * y * Math.sin(4 * l0r) -
        1.25 * e * e * Math.sin(2 * mr)
    );

  // Angle horaire vrai (deg) : minutes UTC du jour + équation du temps + longitude
  const minutesUtc = (((ts / 60000) % 1440) + 1440) % 1440;
  const trueSolarMin = (minutesUtc + eqTime + 4 * lonDeg + 1440) % 1440;
  const hourAngle = trueSolarMin / 4 - 180; // −180 (minuit) → 0 (midi solaire) → +180

  const latR = rad(latDeg);
  const haR = rad(hourAngle);

  // Élévation
  const cosZen = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(haR);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevation = 90 - deg(zen);

  // Azimut (0 = Nord, sens horaire)
  const sinZen = Math.sin(zen);
  let azimuth: number;
  if (Math.abs(sinZen) < 1e-6) {
    azimuth = 180;
  } else {
    const cosAz = (Math.sin(latR) * cosZen - Math.sin(decl)) / (Math.cos(latR) * sinZen);
    const az = deg(Math.acos(Math.min(1, Math.max(-1, cosAz))));
    azimuth = hourAngle > 0 ? (180 + az) % 360 : (180 - az + 360) % 360;
  }

  return { elevationDeg: elevation, azimuthDeg: azimuth };
}

/**
 * Cosinus de l'angle d'incidence du soleil sur un plan incliné.
 * `tiltDeg` = inclinaison du panneau (0 = à plat), `panelAzDeg` = orientation
 * (180 = plein Sud). Retour borné ≥ 0 (0 = soleil derrière/rasant le plan).
 */
export function planeIncidenceCos(sun: SunPosition, tiltDeg: number, panelAzDeg: number): number {
  if (sun.elevationDeg <= 0) return 0;
  const zen = rad(90 - sun.elevationDeg);
  const tilt = rad(tiltDeg);
  const cosInc =
    Math.cos(zen) * Math.cos(tilt) +
    Math.sin(zen) * Math.sin(tilt) * Math.cos(rad(sun.azimuthDeg - panelAzDeg));
  return Math.max(0, cosInc);
}
