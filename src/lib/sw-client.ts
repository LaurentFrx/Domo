/**
 * Enregistrement ET MISE À JOUR du service worker.
 *
 * Jusqu'au 08/08/2026, personne ne s'en chargeait : `push-client` l'enregistrait
 * au moment d'activer les notifications, puis plus rien ne le revérifiait
 * jamais. Un service worker actif sert son precache tant qu'il n'est pas
 * remplacé — l'app restait donc figée sur le bundle de ce jour-là, déploiement
 * après déploiement, sans que rien ne change à l'écran.
 *
 * Le navigateur ne revérifie le script de lui-même qu'à l'occasion d'une
 * navigation dans le scope (et au plus une fois par 24 h). Une PWA iOS reste
 * ouverte des jours sans navigation réelle : sans la sonde ci-dessous, la mise
 * à jour n'arrive pour ainsi dire jamais.
 *
 * Le SW généré porte `skipWaiting` + `clientsClaim` : une nouvelle version
 * prend la main dès qu'elle est installée. Les chunks JS déjà chargés par la
 * page, eux, appartiennent à l'ancienne — d'où le rechargement au changement
 * de contrôleur.
 *
 * ⚠️ CE RECHARGEMENT-CI EST HORS NAVIGATION. C'est un second chemin, distinct
 * de celui de `beforeNavigate` dans le layout : il part du service worker, pas
 * d'un clic. Avoir gardé l'un sans l'autre a coûté une après-midi de fausses
 * pistes — la musique se coupait « en ouvrant une page » alors que c'était la
 * sonde de mise à jour qui tombait à cet instant. Toute garde posée sur l'un
 * doit l'être sur l'autre.
 */

/** Délai minimal entre deux vérifications (le retour au premier plan est fréquent). */
const CHECK_EVERY_MS = 30 * 60 * 1000;

/** Rythme auquel on reteste si le rechargement différé peut enfin se faire. */
const REESSAI_MS = 5000;

let lastCheck = 0;
let started = false;

/**
 * @param peutRecharger Rendu `false` quand un rechargement serait brutal —
 *   typiquement pendant une écoute. Le rechargement est alors DIFFÉRÉ, pas
 *   annulé : il se fera dès que la condition se lève.
 */
export function setupServiceWorker(peutRecharger: () => boolean = () => true): void {
  if (started || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  started = true;

  // Une page SANS contrôleur est un premier enregistrement : le changement de
  // contrôleur qui suit est normal et ne doit PAS provoquer de rechargement.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  let attente: ReturnType<typeof setInterval> | null = null;

  const recharger = () => {
    if (reloading) return;
    if (!peutRecharger()) {
      // Différé : on retente régulièrement plutôt que d'abandonner, sinon
      // l'app resterait sur l'ancien code jusqu'à la prochaine ouverture.
      attente ??= setInterval(recharger, REESSAI_MS);
      return;
    }
    reloading = true;
    if (attente) clearInterval(attente);
    location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    recharger();
  });

  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((reg) => {
      const check = () => {
        const now = Date.now();
        if (now - lastCheck < CHECK_EVERY_MS) return;
        lastCheck = now;
        void reg.update().catch(() => undefined);
      };
      lastCheck = Date.now();
      void reg.update().catch(() => undefined);
      // Au retour au premier plan plutôt qu'en minuterie de fond : c'est le
      // moment où l'utilisateur revient, et rien ne tourne pendant qu'il est
      // ailleurs (règle Domo).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    })
    .catch((e) => console.error('[sw] enregistrement échoué:', e));
}
