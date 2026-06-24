/**
 * Comptage de références pour le cycle de vie PARTAGÉ d'un store page-scoped.
 *
 * Contexte : avec le pager (page courante + voisines réellement montées), un même
 * store peut être « acquis » par plusieurs pages à la fois (ex. `zigbee` par
 * Énergie + Climat + Pièces). Les `connect()`/`disconnect()` binaires d'origine
 * couperaient le polling dès qu'UNE page se démonte, alors que d'autres l'utilisent
 * encore. Ici, le démarrage n'a lieu qu'au passage 0→1 et l'arrêt qu'au passage 1→0.
 *
 * Idiome page (onMount/onDestroy) :
 *   let releases: (() => void)[] = [];
 *   onMount(() => { releases = [acquire(zigbee), acquire(weather), …]; });
 *   onDestroy(() => { releases.forEach((r) => r()); releases = []; });
 *
 * Le `release` retourné est idempotent (un double appel ne décrémente qu'une fois).
 * Les stores APP-WIDE (anker/apsystems/em50/savings/tariff/health, pilotés par le
 * layout) ne passent PAS par ici : ils vivent tant que l'app vit.
 */

interface Lifecycle {
  connect(): void;
  disconnect(): void;
}

const counts = new Map<unknown, number>();
const stoppers = new Map<unknown, () => void>();

/**
 * Acquiert une ressource identifiée par `key` (objet store ou chaîne).
 * `start` est appelé au premier acquéreur, `stop` au dernier qui relâche.
 * Utiliser une CLÉ DISTINCTE par aspect de cycle de vie d'un même objet
 * (ex. 'cumulus:relay' vs 'cumulus:orchestrator') pour ne pas mélanger les compteurs.
 * Retourne la fonction de relâchement (idempotente).
 */
export function acquireFns(key: unknown, start: () => void, stop: () => void): () => void {
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  if (n === 1) {
    stoppers.set(key, stop);
    start();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const m = (counts.get(key) ?? 1) - 1;
    counts.set(key, Math.max(0, m));
    if (m <= 0) {
      const s = stoppers.get(key);
      stoppers.delete(key);
      s?.();
    }
  };
}

/** Raccourci pour un store au contrat `connect()`/`disconnect()` (clé = le store). */
export function acquire(store: Lifecycle): () => void {
  return acquireFns(
    store,
    () => store.connect(),
    () => store.disconnect()
  );
}
