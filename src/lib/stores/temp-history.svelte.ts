/**
 * Pilote global du pop-up « historique de température ».
 *
 * Un seul `<TempHistorySheet>` est monté dans le layout ; n'importe quel site
 * d'affichage d'une température devient cliquable en appelant
 * `openTempHistory(key, label)` — `key` = clé du registre serveur (cf.
 * src/lib/server/temperature/registry.ts), `label` = libellé affiché (souvent
 * la valeur live de la pièce / zone).
 */

class TempHistoryState {
  open = $state(false);
  sensorKey = $state<string | null>(null);
  label = $state('');

  openFor(key: string, label: string) {
    this.sensorKey = key;
    this.label = label;
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

export const tempHistory = new TempHistoryState();

/** Ouvre le pop-up historique 4 h pour un capteur. */
export function openTempHistory(key: string, label: string) {
  tempHistory.openFor(key, label);
}
