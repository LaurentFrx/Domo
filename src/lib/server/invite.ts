/**
 * Liens d'invitation nominatifs — server-only.
 *
 * Ce que ça remplace : jusqu'ici un unique `AUTH_TOKEN`, permanent, partagé par
 * SMS, qui ouvrait une session AU NOM DE L'ADMIN quel que soit qui cliquait.
 * Conséquence : retirer quelqu'un du magasin ne le coupait de rien, et toute
 * personne détenant le lien pouvait tout piloter. Un jeton par personne, à
 * durée de vie bornée, referme les deux.
 *
 * PAS DE HACHAGE LENT ICI, contrairement au PIN : un jeton de 32 octets tirés
 * au hasard n'est pas devinable, il n'y a donc rien à ralentir. Un SHA-256
 * suffit à ce que le vol de `users.json` ne livre pas de liens utilisables.
 *
 * POURQUOI PAS « USAGE UNIQUE » : les liens partent par SMS et WhatsApp, dont
 * les aperçus PRÉCHARGENT l'URL. Un lien à usage unique serait consommé par le
 * robot d'aperçu avant même que la personne ne le touche — le mécanisme
 * échouerait précisément dans son cas d'usage nominal. On borne donc dans le
 * TEMPS (7 jours par défaut), pas en nombre d'ouvertures ; une fois entrée, la
 * personne a son cookie d'un an et le lien peut être révoqué à tout moment.
 */
import crypto from 'node:crypto';

/** Durée de vie par défaut d'une invitation. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_BYTES = 32;

/** Jeton brut, transmis UNE fois à l'administrateur et jamais stocké tel quel. */
export function createInviteToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Comparaison à temps constant de deux empreintes hexadécimales. */
export function inviteHashMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** Un jeton plausible : base64url, longueur attendue. Évite de balayer le
 *  magasin pour une chaîne qui ne peut de toute façon pas correspondre. */
export function looksLikeInviteToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
