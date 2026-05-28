/**
 * Helpers pour générer des séries mock réalistes — basé sur l'heure courante.
 *
 * Toutes les fonctions sont déterministes pour une heure donnée, ce qui permet
 * un rendu cohérent à travers les stores au chargement.
 *
 * Localisation : Sanguinet (Landes), climat océanique tempéré, mai.
 */

/** Heure flottante locale (0-24), ex: 13.5 pour 13h30. */
export function hourOfDay(date = new Date()): number {
  return date.getHours() + date.getMinutes() / 60;
}

/**
 * Production PV solaire — gaussienne centrée 13h, max 2.5 kW en mai.
 * @returns kW
 */
export function solarPV(hour: number, peakKw = 2.5): number {
  if (hour < 6.5 || hour > 21) return 0;
  const sigma = 3.2;
  const peak = (hour - 13) / sigma;
  return Math.max(0, peakKw * Math.exp(-0.5 * peak * peak));
}

/**
 * Consommation maison — base 0.4 kW, pics matin 7-9h et soir 19-21h.
 * @returns kW
 */
export function homeConsumption(hour: number): number {
  const base = 0.35;
  const morning = 1.8 * Math.exp(-0.5 * Math.pow((hour - 7.5) / 0.8, 2));
  const evening = 2.2 * Math.exp(-0.5 * Math.pow((hour - 20) / 1.1, 2));
  const noise = 0.1 * Math.sin(hour * 7);
  return Math.max(0.25, base + morning + evening + noise);
}

/**
 * SoC batterie — décharge nuit, charge journée si surplus PV.
 * @returns 0-100
 */
export function batterySoc(hour: number): number {
  if (hour < 7) return Math.max(20, 70 - (hour + 1) * 5);
  if (hour < 12) return Math.min(95, 40 + (hour - 7) * 11);
  if (hour < 18) return 95;
  return Math.max(30, 95 - (hour - 18) * 9);
}

/**
 * Température cumulus — cycles 45-68°C, plus haut en fin de journée PV.
 * @returns °C
 */
export function cumulusTemp(hour: number): number {
  if (hour < 6) return 52 - hour * 1.5;
  if (hour < 14) return 45 + (hour - 6) * 2.3;
  if (hour < 18) return Math.min(68, 63 + (hour - 14) * 0.5);
  return Math.max(52, 65 - (hour - 18) * 1.2);
}

/**
 * Température extérieure Sanguinet en mai.
 * @returns °C
 */
export function outdoorTemp(hour: number): number {
  const min = 13;
  const max = 22;
  const phase = (hour - 6) / 24;
  return min + (max - min) * Math.max(0, Math.sin(phase * Math.PI));
}

/** Humidité extérieure typique mai Landes. */
export function outdoorHumidity(hour: number): number {
  if (hour < 8) return 85 - hour;
  if (hour < 15) return Math.max(55, 80 - (hour - 8) * 4);
  return Math.min(85, 55 + (hour - 15) * 3);
}

/** Tarif EDF Tempo (HC/HP) — bascule à 22h et 6h. */
export function tariffMode(hour: number): 'HC' | 'HP' {
  return hour < 6 || hour >= 22 ? 'HC' : 'HP';
}

/** Prix kWh en cours (€). */
export function tariffPrice(hour: number): number {
  return tariffMode(hour) === 'HC' ? 0.1812 : 0.2318;
}

/**
 * Génère 24 points de PV (1 point/h) pour graphes sparkline.
 */
export function pvSeries24h(peakKw = 2.5): number[] {
  return Array.from({ length: 24 }, (_, h) => solarPV(h, peakKw));
}

/**
 * Génère 24 points de consommation pour graphes sparkline.
 */
export function consoSeries24h(): number[] {
  return Array.from({ length: 24 }, (_, h) => homeConsumption(h));
}

/** Date "humanisée" — utilisé pour le countdown anti-légionellose. */
export function daysUntil(date: Date): number {
  const ms = date.getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 3600 * 1000)));
}
