/**
 * Types de la prévision Solcast — utilisés par l'endpoint serveur
 * /api/solcast/forecast et le store stores/solcast.svelte.ts (à terme,
 * mode 'direct').
 */

export interface ForecastPoint {
  /** ISO 8601 UTC du end-of-period. */
  time: string;
  /** Estimation médiane P50 (kW). */
  pvEstimate: number;
  /** Borne basse P10 (kW). */
  pvEstimate10: number;
  /** Borne haute P90 (kW). */
  pvEstimate90: number;
  /** Durée du créneau en secondes (30 min = 1800). */
  periodSeconds: number;
}

export interface ForecastResponse {
  /** Date du fetch côté serveur. */
  fetchedAt: string;
  /** Points de prévision pour les ~7 prochains jours. */
  points: ForecastPoint[];
}
