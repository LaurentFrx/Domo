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

/** Garde : nombre fini et positif, sinon 0 (gère aussi null/undefined). */
function safePos(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

class ProductionState {
  /** PV instantané APsystems (W). 0 si indisponible (getter apsystems déjà gardé). */
  get apsW(): number {
    return safePos(apsystems.powerW);
  }

  /** PV instantané SolarBank, niveau site (W). 0 si anker non connecté. */
  get sbW(): number {
    return anker.connected ? safePos(anker.solarPowerW) : 0;
  }

  /** Production PV réelle instantanée totale (W) = APS + SolarBank. */
  get productionNowW(): number {
    return this.apsW + this.sbW;
  }

  /** Cumul lifetime APsystems EZ1 (kWh). 0 si jamais relevé (null) ou invalide. */
  get apsLifetimeKwh(): number {
    return safePos(apsystems.lifetimeKwh);
  }

  /** Cumul lifetime SolarBank (kWh, cloud Solix). 0 si anker non connecté. */
  get sbLifetimeKwh(): number {
    return anker.connected ? safePos(anker.lifetimeProductionKwh) : 0;
  }

  /**
   * Production cumulée TOTALE de l'installation (kWh) = SolarBank (SB1+SB2) +
   * onduleur APsystems EZ1. L'accueil n'affichait que le cumul Anker → la part
   * APS (pan Sud) manquait, sous-estimant la « Production totale » et l'équivalent
   * VE. L'APS expose son propre lifetime (null tant que non relevé → +0).
   */
  get lifetimeKwh(): number {
    return this.sbLifetimeKwh + this.apsLifetimeKwh;
  }
}

export const production = new ProductionState();
