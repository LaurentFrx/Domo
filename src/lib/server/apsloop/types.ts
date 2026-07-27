/**
 * Boucle de bridage de l'onduleur APS EZ1 — types.
 *
 * BUT : l'installation est déclarée en autoconsommation SANS injection (convention
 * Enedis CACSI). L'APS est couplé AC et ne régule rien : quand la maison consomme
 * moins qu'il ne produit et que le stockage est plein, son surplus part au réseau.
 * Contrairement aux Solarbank, il se MODULE au watt près par son API locale
 * (setMaxPower 30→960 W) : pas de relais, pas d'usure, réversible instantanément.
 */

export interface ApsLoopConfig {
  /** Injection (W) au-delà de laquelle on envisage de brider. */
  exportOnW: number;
  /** ...si elle PERSISTE ce temps. Laisse d'abord agir la régulation matérielle
   *  de la Max AC (qui travaille en secondes) — séparation des échelles de temps. */
  exportSustainSec: number;
  /** Injection (W) sous laquelle on considère le réseau « propre » et on remonte. */
  exportClearW: number;
  /** Marge de sécurité sous la cible calculée (on vise légèrement bas). */
  marginW: number;
  /** Pas de remontée du plafond (W). Asymétrie assumée (bride vite / remonte moins
   *  vite), MAIS la remontée doit rester franche : bridé bas, l'onduleur ne produit
   *  plus et la maison est alors couverte par la BATTERIE — sans provoquer d'import,
   *  donc sans signal d'alarme. Une remontée trop lente ferait brûler de la batterie
   *  à la place de solaire gratuit. 150 W/min ⇒ retour au maximum en ~6 min. */
  raiseStepW: number;
  /** Délai entre deux remontées (s). */
  raiseDwellSec: number;
  /** Délai minimal entre deux écritures quelconques (s). */
  dwellSec: number;
  /** Écart sous lequel on n'écrit pas (évite les écritures inutiles). */
  deadbandW: number;
}

export function defaultApsLoopConfig(): ApsLoopConfig {
  return {
    exportOnW: 150,
    exportSustainSec: 90,
    exportClearW: 50,
    marginW: 50,
    raiseStepW: 150,
    raiseDwellSec: 60,
    dwellSec: 30,
    deadbandW: 25
  };
}

export interface ApsLoopInputs {
  now: number;
  /** Réseau signé (W) : + soutirage EDF / − injection. Mesure EM-50. */
  gridW: number;
  /** Le compteur répond-il ? Faux ⇒ on ne bride JAMAIS à l'aveugle. */
  em50Available: boolean;
  /** Production APS instantanée (W). */
  apsW: number;
  /** L'onduleur répond-il ? (faux la nuit : il dort) */
  apsAvailable: boolean;
  /** Plafond actuellement appliqué à l'onduleur (W). */
  apsMaxW: number;
  /** Bornes de l'appareil, lues sur l'appareil (30 / 960). */
  apsMinLimitW: number;
  apsMaxLimitW: number;
}

export interface ApsLoopState {
  /** Depuis quand l'injection dépasse exportOnW en continu (null = pas en cours). */
  exportSinceTs: number | null;
  /** Dernière écriture émise (ms) et sa valeur. */
  lastWriteTs: number | null;
  lastCmdW: number | null;
}

export function defaultApsLoopState(): ApsLoopState {
  return { exportSinceTs: null, lastWriteTs: null, lastCmdW: null };
}

export type ApsLoopMode =
  | 'off' // boucle désactivée
  | 'failsafe' // compteur muet → plafond rendu au maximum
  | 'night' // onduleur endormi → plafond rendu au maximum (prêt pour demain)
  | 'import' // la maison soutire → priorité absolue à la production
  | 'throttle' // injection persistante → on abaisse le plafond
  | 'raise' // réseau propre → on remonte par paliers
  | 'hold'; // rien à faire (bande morte, temporisation, déjà au plafond)

export interface ApsDecision {
  mode: ApsLoopMode;
  /** Plafond à écrire (W), ou null si aucune écriture à faire ce tick. */
  writeW: number | null;
  /** Cible calculée avant amortisseurs (diagnostic). */
  targetW: number;
  reason: string;
  nextState: ApsLoopState;
}
