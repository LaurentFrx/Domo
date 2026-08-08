/**
 * POST /api/auth/pin-login — se connecter avec email + PIN.
 *
 * Route PUBLIQUE (déclarée dans hooks.server.ts) : c'est la voie de secours
 * quand on n'a plus le lien magique sous la main. Elle reste soumise au
 * contrôle anti-CSRF global — les deux mécanismes du hook sont distincts, et
 * l'ordre y a été corrigé pour que « public » ne veuille pas dire « sans CSRF ».
 *
 * DISCRÉTION : « compte inconnu », « aucun PIN défini » et « mauvais code »
 * renvoient tous EXACTEMENT la même réponse. Distinguer les cas dirait à un
 * visiteur quelles adresses existent dans le foyer. Seul le verrouillage se
 * distingue — le taire rendrait l'attente incompréhensible pour la personne
 * légitime, et il ne se déclenche de toute façon qu'après 3 essais sur un
 * compte réel.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { attemptPinLogin } from '$lib/server/users-store';
import { isValidPinFormat } from '$lib/server/pin';
import { setSessionCookie } from '$lib/server/auth';
import { clientKey, createRateLimiter } from '$lib/server/rate-limit';

const GENERIQUE = 'Email ou code incorrect.';

/**
 * Limite PAR APPELANT, indépendante et cumulative avec le verrou par compte.
 *
 * Le verrou de compte (3 essais / 15 min) rend impossible de deviner UN code ;
 * il ne dit rien de quelqu'un qui balaie beaucoup d'adresses, ni du coût
 * machine — chaque tentative paie un scrypt de ~44 ms, soit une poignée de
 * requêtes par seconde pour saturer un cœur. D'où cette seconde barrière.
 *
 * 10 essais par quart d'heure : très au-delà de ce qu'une personne qui hésite
 * sur son code produira, très en deçà de ce qu'un balayage exige.
 */
const limiteIp = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

export const POST: RequestHandler = async (event) => {
  const { request, cookies } = event;

  // AVANT toute lecture du magasin : une IP déjà bloquée ne doit coûter ni
  // accès disque, ni scrypt (y compris le dummyVerify d'égalisation).
  const appelant = clientKey(event);
  const verdict = limiteIp.hit(appelant);
  if (verdict.limited) {
    console.warn(`[pin-login] limite par appelant atteinte (${appelant})`);
    return json(
      {
        error: 'trop_de_tentatives',
        message: 'Trop de tentatives, réessaie plus tard.',
        retryAfterMs: verdict.retryAfterMs
      },
      { status: 429, headers: { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) } }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    pin?: unknown;
  } | null;

  const email = typeof body?.email === 'string' ? body.email : '';

  if (!email || !isValidPinFormat(body?.pin)) {
    return json({ error: 'format', message: GENERIQUE }, { status: 400 });
  }

  const result = await attemptPinLogin(email, body.pin as string);

  if (result.ok) {
    setSessionCookie(cookies, result.userId);
    return json({ ok: true, redirect: '/' });
  }

  if (result.reason === 'locked') {
    const minutes = Math.ceil(result.retryAfterMs / 60_000);
    return json(
      {
        error: 'verrouille',
        message: `Trop de tentatives. Réessaie dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
        retryAfterMs: result.retryAfterMs
      },
      { status: 429, headers: { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) } }
    );
  }

  // Journal côté serveur SEULEMENT : le motif précis est utile pour comprendre
  // un incident, mais il ne franchit jamais la réponse HTTP.
  console.warn(`[pin-login] échec (${result.reason}) ip=${appelant}`);

  return json({ error: 'refuse', message: GENERIQUE }, { status: 401 });
};
