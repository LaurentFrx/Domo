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
const pendingStops = new Map<unknown, ReturnType<typeof setTimeout>>();

/** Grâce avant l'arrêt réel au passage 1→0 : le layout démonte la page rendue
 * par le routeur puis la remonte dans le Pager juste après l'hydratation — le
 * même store est relâché puis ré-acquis dans la foulée. Sans grâce, ça coupait
 * le polling (disconnect) et le redémarrait (connect → fetch immédiat) : des
 * requêtes en double au moment précis où l'utilisateur attend ses premiers
 * chiffres. Une ré-acquisition pendant la grâce annule l'arrêt, la ressource
 * ne s'aperçoit de rien. */
const STOP_GRACE_MS = 2_500;

/**
 * Acquiert une ressource identifiée par `key` (objet store ou chaîne).
 * `start` est appelé au premier acquéreur, `stop` au dernier qui relâche
 * (différé de STOP_GRACE_MS, annulé si ré-acquis entre-temps).
 * Utiliser une CLÉ DISTINCTE par aspect de cycle de vie d'un même objet
 * (ex. 'cumulus:relay' vs 'cumulus:orchestrator') pour ne pas mélanger les compteurs.
 * Retourne la fonction de relâchement (idempotente).
 */
export function acquireFns(key: unknown, start: () => void, stop: () => void): () => void {
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  const pending = pendingStops.get(key);
  if (pending !== undefined) {
    // Arrêt différé pas encore tiré : la ressource tourne toujours — on annule
    // simplement l'arrêt, sans re-start (le `stop` d'origine reste enregistré).
    clearTimeout(pending);
    pendingStops.delete(key);
  } else if (n === 1) {
    stoppers.set(key, stop);
    start();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const m = (counts.get(key) ?? 1) - 1;
    counts.set(key, Math.max(0, m));
    if (m <= 0 && !pendingStops.has(key)) {
      const t = setTimeout(() => {
        pendingStops.delete(key);
        if ((counts.get(key) ?? 0) > 0) return; // ré-acquis entre-temps (filet)
        const s = stoppers.get(key);
        stoppers.delete(key);
        s?.();
      }, STOP_GRACE_MS);
      pendingStops.set(key, t);
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
