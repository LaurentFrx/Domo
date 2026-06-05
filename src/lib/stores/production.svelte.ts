/**
 * Store « Production maintenant » — production PV réelle instantanée totale.
 *
 * Agrège (sans poller lui-même) les deux singletons déjà existants :
 *   - apsystems (onduleur APsystems EZ1, bridge 8100) → apsystems.powerW
 *   - anker     (SolarBank, bridge 8095)              → anker.solarPowerW (PV site)
 *
 * Purement dérivé : le polling des sources est géré par leurs pages (apsystems
 * sur la page Énergie ; anker dans +layout.svelte, app-wide). Les getters lisent
 * l'état réactif des deux stores → réactifs en composant.
 *
 * Robustesse : valeur manquante ou source indisponible → 0 (jamais NaN, jamais
 * négatif).
 */
import { anker } from './anker.svelte';
import { apsystems } from './apsystems.svelte';

/** Garde : nombre fini et positif, sinon 0. */
function safeW(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

class ProductionState {
  /** PV instantané APsystems (W). 0 si indisponible (getter apsystems déjà gardé). */
  get apsW(): number {
    return safeW(apsystems.powerW);
  }

  /** PV instantané SolarBank, niveau site (W). 0 si anker non connecté. */
  get sbW(): number {
    return anker.connected ? safeW(anker.solarPowerW) : 0;
  }

  /** Production PV réelle instantanée totale (W) = APS + SolarBank. */
  get productionNowW(): number {
    return this.apsW + this.sbW;
  }
}

export const production = new ProductionState();
