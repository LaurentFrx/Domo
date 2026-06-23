import { redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { isAuthenticated } from '$lib/server/auth';
import { setIncidentReporter } from '$lib/server/atomic-store';
import { raiseIncident, resolveIncident } from '$lib/server/monitor/incidents';

// Branche la remontée d'incidents du socle de persistence sur le bus (une fois,
// au chargement du serveur) : une corruption de fichier d'état devient une alerte.
setIncidentReporter(
  (i) => void raiseIncident(i),
  (key, repaired) => void resolveIncident(key, repaired)
);

const PUBLIC_PATHS = ['/auth', '/denied'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

function isAsset(pathname: string): boolean {
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
 *  (sauf si la route fixe elle-même sa politique, ex. Solcast 6 h). */
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

  if (isAsset(pathname) || isPublic(pathname)) {
    return resolve(event);
  }

  if (!isAuthenticated(event.cookies)) {
    throw redirect(303, '/denied');
  }

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
