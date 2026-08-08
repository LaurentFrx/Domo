/**
 * Limitation de débit en mémoire — fenêtre glissante par clé.
 *
 * Extrait de `/api/portail/pulse`, qui en portait la seule implémentation, pour
 * pouvoir la réutiliser sans dupliquer. Chaque route crée SA PROPRE instance :
 * les seaux ne sont jamais partagés entre endpoints — sinon un raccourci portail
 * un peu nerveux consommerait le quota du formulaire de connexion.
 *
 * En mémoire, donc : les compteurs repartent à zéro à chaque redémarrage du
 * service. C'est acceptable ici — le redémarrage n'est pas déclenchable depuis
 * l'extérieur, et la vraie protection du PIN reste le verrou PAR COMPTE, lui
 * persisté dans users.json.
 */

export interface RateLimitVerdict {
  /** Vrai si l'appel dépasse le seuil (l'appel est tout de même comptabilisé). */
  limited: boolean;
  /** Temps avant que le plus ancien coup ne sorte de la fenêtre. 0 si non limité. */
  retryAfterMs: number;
}

export interface RateLimiterOpts {
  windowMs: number;
  /** Nombre d'appels TOLÉRÉS dans la fenêtre ; le suivant est limité. */
  max: number;
  /** Au-delà, purge des clés inactives pour borner la mémoire. */
  maxKeys?: number;
}

export function createRateLimiter(opts: RateLimiterOpts) {
  const { windowMs, max, maxKeys = 500 } = opts;
  const hits = new Map<string, number[]>();

  return {
    /**
     * Enregistre un appel et rend le verdict.
     *
     * L'appel est compté MÊME quand il est refusé : marteler l'endpoint
     * prolonge donc son propre bannissement au lieu de le raccourcir. C'est le
     * comportement d'origine de portail/pulse, conservé tel quel.
     */
    hit(key: string): RateLimitVerdict {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      recent.push(now);
      hits.set(key, recent);

      // GC grossier : purge les clés inactives pour borner la mémoire.
      if (hits.size > maxKeys) {
        for (const [k, v] of hits) {
          if (v.every((t) => now - t >= windowMs)) hits.delete(k);
        }
      }

      if (recent.length > max) {
        return { limited: true, retryAfterMs: Math.max(1, windowMs - (now - recent[0])) };
      }
      return { limited: false, retryAfterMs: 0 };
    }
  };
}

/** Adresses du proxy local : une requête vue depuis l'une d'elles vient de Caddy. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Identifie l'appelant pour la limitation de débit.
 *
 * POURQUOI CE DÉTOUR : Caddy termine le TLS et relaie vers 127.0.0.1:3000. Sans
 * `ADDRESS_HEADER` dans l'unité systemd, `getClientAddress()` renvoie donc
 * l'adresse de la SOCKET, c'est-à-dire toujours `127.0.0.1` — vérifié sur les
 * journaux de production, 186 requêtes sur 186. Une limite « par IP » posée
 * dessus serait en réalité une limite GLOBALE : n'importe qui pourrait épuiser
 * le seau depuis l'extérieur et priver toute la maison du formulaire de secours.
 *
 * On lit donc `X-Forwarded-For`, mais UNIQUEMENT si la socket vient du proxy
 * local — sinon un appelant direct forgerait la clé qu'il veut. Et on prend la
 * DERNIÈRE entrée : Caddy AJOUTE l'adresse réelle en fin de liste, ce qu'un
 * client peut précéder de valeurs bidon mais jamais suivre.
 */
export function clientKey(event: { getClientAddress: () => string; request: Request }): string {
  let socket = 'inconnue';
  try {
    socket = event.getClientAddress();
  } catch {
    /* adresse indisponible selon l'adaptateur — non bloquant */
  }

  if (LOOPBACK.has(socket)) {
    const xff = event.request.headers.get('x-forwarded-for');
    if (xff) {
      const dernier = xff.split(',').pop()?.trim();
      if (dernier) return dernier;
    }
  }
  return socket;
}
