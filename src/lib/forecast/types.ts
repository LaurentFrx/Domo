/**
 * Types pour la prévision PV (provider Solcast).
 *
 * Le modèle est volontairement provider-agnostique : la réponse Solcast
 * est mappée vers `ForecastPoint` côté serveur, le client ne connaît
 * que ce format normalisé.
 */

export interface ForecastPoint {
  /** Horodatage de fin de période, ISO 8601 UTC. */
  time: string;
  /** Estimation centrale de production (kW). */
  pvEstimate: number;
  /** Estimation pessimiste (percentile 10, kW). */
  pvEstimate10: number;
  /** Estimation optimiste (percentile 90, kW). */
  pvEstimate90: number;
  /** Durée de la période en secondes (typiquement 1800 = 30 min). */
  periodSeconds: number;
}

export interface ForecastResponse {
  /** Points de prévision triés par `time` croissant. */
  points: ForecastPoint[];
  /** Horodatage ISO du fetch côté serveur. */
  fetchedAt: string;
}
