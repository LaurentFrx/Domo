/**
 * Position solaire — le calcul (NOAA simplifié, TS pur) vit dans `$utils/sun`
 * depuis le 23/08/2026 : la carte Store (client) en a besoin pour ses ombres.
 * Ce module ne fait que ré-exporter, pour ne rien changer côté serveur.
 */
export { sunPosition, planeIncidenceCos } from '$utils/sun';
export type { SunPosition } from '$utils/sun';
