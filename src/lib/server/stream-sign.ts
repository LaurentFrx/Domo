/**
 * Signature des URL de flux audio — le laissez-passer des enceintes AirPlay.
 *
 * En AirPlay « external playback », c'est L'ENCEINTE qui vient chercher le
 * flux (constaté avec la chaîne CEOL : session établie, titre affiché, volume
 * réglable… et piste « vide », car sa requête sans cookie prenait le 303 vers
 * /denied). Les URL de flux portent donc une signature HMAC à durée limitée,
 * posée côté serveur par mapTrack : `?st=<exp>.<hmac>`. Le hook laisse passer
 * un GET de flux dont la signature est valide — et RIEN d'autre (chemin exact,
 * expiration, comparaison à temps constant : ce n'est pas un « isAsset » bis,
 * cf. l'audit du bypass d'auth).
 *
 * Clé = AUTH_TOKEN (déjà secret serveur, jamais côté client) avec un préfixe
 * d'usage — compromettre une signature ne donne accès qu'À CE fichier, pour la
 * durée de vie du jeton.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

/** Durée de vie d'une signature. Longue à dessein : les listes de pistes sont
 *  cachées côté client (albums, file de lecture) et doivent rester jouables
 *  toute une session d'écoute ; le client d'une PWA se recharge bien avant. */
const TTL_S = 7 * 24 * 3600;

function key(): string | null {
  const k = (env.AUTH_TOKEN || '').trim();
  return k || null;
}

function hmac(part: string, exp: number, k: string): string {
  return createHmac('sha256', k).update(`stream|${part}|${exp}`).digest('hex').slice(0, 32);
}

/** `/library/parts/…/file.flac` → même chemin suffixé `?st=<exp>.<sig>`. */
export function signStreamPart(part: string): string {
  const k = key();
  if (!k) return part; // pas de secret configuré : URL nue (auth cookie seule)
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  return `${part}?st=${exp}.${hmac(part, exp, k)}`;
}

/** Vérifie `?st=` pour un chemin de part (avec son / de tête). */
export function verifyStreamToken(part: string, token: string | null): boolean {
  const k = key();
  if (!k || !token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const given = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(hmac(part, exp, k));
  return given.length === want.length && timingSafeEqual(given, want);
}
