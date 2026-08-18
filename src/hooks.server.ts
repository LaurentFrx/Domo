import { error, redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, verifySessionCookie } from '$lib/server/auth';
import { findUserById } from '$lib/server/users-store';
import { reservePour } from '$lib/server/access';
import { setIncidentReporter } from '$lib/server/atomic-store';
import { raiseIncident, resolveIncident } from '$lib/server/monitor/incidents';
// Import d'amorçage : arme les timers de fond du mode Musique (réconciliation
// post-restart + poll d'alimentation du ruban) DÈS LE BOOT du serveur — sans
// lui, ils n'existeraient qu'au premier accès à une route /api/wled.
import '$lib/server/wled/music-mode';

// Branche la remontée d'incidents du socle de persistence sur le bus (une fois,
// au chargement du serveur) : une corruption de fichier d'état devient une alerte.
setIncidentReporter(
  (i) => void raiseIncident(i),
  (key, repaired) => void resolveIncident(key, repaired)
);

// Arrêt PROPRE du process : adapter-node émet 'sveltekit:shutdown' une fois le
// serveur HTTP fermé (SIGTERM + toutes connexions closes), mais ne termine pas
// le process — il compte sur une event loop vide. Or nos handles de fond
// (client MQTT singleton en reconnexion auto, timers music-mode, socket UDP
// beat) la maintiennent vivante → node ne sortait jamais, systemd attendait
// TimeoutStop (90 s) puis SIGKILL : chaque `systemctl restart domo` = ~90 s de
// coupure totale (app figée, commandes clim/cumulus inopérantes). Couplé à
// SHUTDOWN_TIMEOUT=3 dans domo.service (coupe les SSE ouvertes → close()
// complète → l'événement est bien émis), l'arrêt tombe à ~3 s.
const proc = process as unknown as {
  once(event: 'sveltekit:shutdown', cb: (reason: 'SIGINT' | 'SIGTERM' | 'IDLE') => void): void;
};
proc.once('sveltekit:shutdown', (reason) => {
  console.log(`[shutdown] serveur HTTP fermé (${reason}) — sortie du process`);
  process.exit(0);
});

const PUBLIC_PATHS = ['/auth', '/denied'];

// Routes publiques à match EXACT (pas de préfixe) : la connexion par PIN doit
// être joignable sans session, mais rien d'autre sous /api/auth ne doit l'être
// — une future /api/auth/… se retrouverait ouverte par simple préfixe.
const PUBLIC_EXACT = ['/api/auth/pin-login'];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function isMutating(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function isAsset(pathname: string): boolean {
  // Une route API n'est JAMAIS un asset, quelle que soit la fin de son URL.
  // Sans ce garde, les `endsWith` ci-dessous exemptent d'authentification tout
  // chemin suffixé .png/.svg/.ico — et les routes à paramètre rest
  // (/api/wled/[...path], /api/plex/stream/[...part]) avalent n'importe quel
  // suffixe : `POST /api/wled/x.png` commandait le module sans cookie.
  if (pathname.startsWith('/api/')) return false;
  return (
    pathname.startsWith('/_app/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/splash/') ||
    pathname === '/favicon.ico' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/push-sw.js' ||
    pathname === '/registerSW.js' ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.ico')
  );
}

/** Données temps réel : jamais de cache navigateur/proxy sur les réponses API
 *  (sauf si la route fixe elle-même sa politique, ex. images Plex 7 j). */
function withApiCacheControl(pathname: string, response: Response): Response {
  if (pathname.startsWith('/api/') && !response.headers.has('cache-control')) {
    response.headers.set('cache-control', 'no-store');
  }
  return response;
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;

  // Endpoint portail : appelable par un raccourci iPhone sans cookie Domo.
  // Sa propre auth par token (Authorization: Bearer) est appliquée dans la route.
  // Match EXACT — ne PAS élargir aux autres routes /api.
  if (pathname === '/api/portail/pulse') {
    return withApiCacheControl(pathname, await resolve(event));
  }

  // Endpoint tick de l'orchestrateur cumulus : appelé par le timer systemd en
  // localhost, sans cookie. Auth par token (Bearer) appliquée dans la route.
  // Match EXACT — ne PAS élargir aux autres routes /api/cumulus.
  if (pathname === '/api/cumulus/tick') {
    return withApiCacheControl(pathname, await resolve(event));
  }

  // Endpoint tick du moniteur de fiabilité : timer systemd en localhost, sans
  // cookie. Auth par token (Bearer) appliquée dans la route. Match EXACT.
  if (pathname === '/api/monitor/tick') {
    return withApiCacheControl(pathname, await resolve(event));
  }

  // Endpoint tick de la boucle SB3 : timer systemd en localhost, sans cookie.
  // Auth par token (Bearer) appliquée dans la route. Match EXACT.
  if (pathname === '/api/sb3loop/tick') {
    return withApiCacheControl(pathname, await resolve(event));
  }

  // Endpoint tick de la boucle de bridage APS : timer systemd en localhost, sans
  // cookie. Auth par token (Bearer) appliquée dans la route. Match EXACT.
  if (pathname === '/api/apsloop/tick') {
    return withApiCacheControl(pathname, await resolve(event));
  }

  // Endpoint tick de la collecte de température : timer systemd en localhost,
  // sans cookie. Auth par token (Bearer) appliquée dans la route. Match EXACT.
  if (pathname === '/api/temperature/tick') {
    return withApiCacheControl(pathname, await resolve(event));
  }

  // Anti-CSRF explicite (défense en profondeur, en plus du checkOrigin SvelteKit) :
  // une commande d'actuateur ou une écriture déclenchée par un AUTRE site, dans le
  // navigateur d'un utilisateur authentifié, est bloquée. Fetch Metadata :
  // same-origin / none (= app elle-même ou client non-navigateur) = OK ; cross-site
  // ou same-site = refus. Les endpoints token (portail/tick/monitor) sont déjà
  // sortis plus haut (curl serveur, sans Sec-Fetch-Site).
  //
  // ⚠️ ORDRE : ce contrôle est AVANT le laissez-passer assets/public. Il était
  // après, ce qui rendait toute route publique implicitement exemptée de CSRF —
  // sans conséquence tant que les routes publiques étaient en lecture seule
  // (/auth, /denied), mais POST /api/auth/pin-login aurait été ouvert à un
  // formulaire hébergé sur un site tiers. « Public » veut dire « sans session »,
  // pas « sans protection ». Les GET publics ne sont pas concernés (non mutants).
  if (pathname.startsWith('/api/') && isMutating(event.request.method)) {
    const site = event.request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return new Response(JSON.stringify({ error: 'cross_site_blocked' }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }
  }

  if (isAsset(pathname) || isPublic(pathname)) {
    return withApiCacheControl(pathname, await resolve(event));
  }

  // Contrôle de session + résolution d'identité. Le refus reste EXACTEMENT le
  // même qu'avant (303 vers /denied) ; ce qui s'ajoute, c'est `locals.user`.
  const session = verifySessionCookie(event.cookies.get(SESSION_COOKIE_NAME));
  if (!session) {
    throw redirect(303, '/denied');
  }

  if (session.legacy) {
    // Cookie anonyme posé avant la phase identité : on ne sait pas qui c'est,
    // on lui laisse donc l'accès qu'il avait déjà, ni plus ni moins. Aucune
    // restriction nouvelle — personne ne doit être dérangé par un changement
    // interne. Sa prochaine visite de /auth le fera passer au format identifié.
    event.locals.user = { id: 'legacy', email: null, role: 'famille' };
  } else {
    // Cookie identifié : le magasin fait AUTORITÉ à chaque requête. Un compte
    // révoqué ou effacé est coupé immédiatement, sans attendre l'expiration du
    // cookie (qui court sur un an) — c'est tout l'intérêt du format identifié.
    const user = await findUserById(session.userId as string);
    if (!user || user.status !== 'active') {
      throw redirect(303, '/denied');
    }
    event.locals.user = { id: user.id, email: user.email, role: user.role };
  }

  // Garde de rôle — UNIQUE point de contrôle de l'app. La table des opérations
  // réservées vit dans $lib/server/access ; les routes ne la redoublent pas.
  // Une session legacy vaut `famille` : elle ne dit pas qui est derrière, elle
  // n'administre donc rien.
  const reserve = reservePour(event.request.method, pathname);
  if (reserve && event.locals.user.role !== 'admin') {
    // Tournure sans accord : les libellés sont de genres différents, « est
    // réservé(e) » produisait « Le réglage … est réservée ».
    // Seule la première lettre descend : un `toLowerCase()` entier écrasait les
    // sigles (« boucle sb3 »).
    const l = reserve.libelle;
    const message = `Réservé à l'administrateur : ${l.charAt(0).toLowerCase()}${l.slice(1)}.`;
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'reserve', message }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    }
    throw error(403, message);
  }

  // « Réglages » n'existe plus comme page : son contenu vit derrière le menu ☰
  // (/menu). On redirige plutôt que de laisser un 404 aux liens déjà partis dans
  // la nature — notifications Web Push envoyées avant la refonte, raccourci
  // iPhone, favori. /reglages/planning suivait le thermostat → sa nouvelle
  // rubrique. APRÈS l'auth : une redirection ne doit pas révéler la carte des
  // routes à un visiteur non authentifié.
  if (pathname === '/reglages/planning') {
    throw redirect(307, '/planning');
  }
  if (pathname === '/reglages' || pathname.startsWith('/reglages/')) {
    throw redirect(307, '/menu');
  }

  // (Le contrôle anti-CSRF a été remonté avant le laissez-passer assets/public —
  // voir plus haut. Un seul point de vérification, pour toutes les routes.)

  return withApiCacheControl(pathname, await resolve(event));
};

/**
 * Filet d'erreur global : aucune exception non rattrapée ne doit partir en 500
 * brute silencieuse. On journalise (route + message) pour l'observabilité et on
 * renvoie un message neutre au client (pas de fuite de détail interne).
 */
export const handleError: HandleServerError = ({ error, event }) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[handleError] ${event.request.method} ${event.url.pathname} — ${message}`);
  return { message: 'Une erreur interne est survenue.' };
};
