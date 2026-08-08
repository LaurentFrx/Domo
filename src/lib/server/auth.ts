/**
 * Auth magic link — server-only.
 *
 * Stratégie :
 *   - Lien magique permanent : /auth?k=<AUTH_TOKEN>
 *   - Un clic pose un cookie httpOnly signé HMAC-SHA256 (1 an)
 *   - Pas de mot de passe, pas de formulaire
 *   - Partager le lien par SMS/WhatsApp, c'est tout
 *
 * DEUX FORMATS DE COOKIE cohabitent (phase 1 « identité ») :
 *   • IDENTIFIÉ  `domo:<userId>:<ts>.<hmac>`  — porte l'utilisateur, seul format
 *     émis désormais ; c'est lui qui rend possibles rôles et révocation.
 *   • LEGACY     `domo:<ts>.<hmac>`           — anonyme, plus jamais émis, mais
 *     TOUJOURS accepté : les cookies déjà posés sur les iPhone de la famille
 *     valent un an. Les invalider, c'est mettre tout le monde dehors du jour au
 *     lendemain pour un changement interne. Ils s'éteindront d'eux-mêmes à la
 *     prochaine visite de /auth, qui réémet au nouveau format.
 * Les deux sont signés avec le MÊME AUTH_SECRET — sa rotation reste le seul
 * geste qui déconnecte tout le monde d'un coup.
 */

import { env } from '$env/dynamic/private';
import type { Cookies } from '@sveltejs/kit';
import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'domo_session';
const COOKIE_NAME = SESSION_COOKIE_NAME;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 an

function getSecret(): string {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_SECRET manquant ou trop court. Ajouter dans .env');
  }
  return secret;
}

// ─── Token signing ─────────────────────────────────────────────────────

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

/** Comparaison à temps constant de deux signatures hex. La longueur est vérifiée
 *  AVANT `timingSafeEqual`, qui jette si les tampons diffèrent en taille. */
function signatureMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/** Cookie LEGACY (anonyme). Conservé pour le repli du flux /auth quand aucun
 *  administrateur n'est déclaré — cf. `setSessionCookie`. */
function createLegacyToken(): string {
  const payload = `domo:${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

/** Cookie IDENTIFIÉ : `domo:<userId>:<ts>.<hmac>`, l'userId étant DANS le
 *  payload signé (le modifier invalide la signature). */
export function createSessionCookie(userId: string): string {
  if (!userId || userId.includes(':') || userId.includes('.')) {
    throw new Error('auth: userId invalide pour un cookie de session');
  }
  const payload = `domo:${userId}:${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

// ─── Vérification ──────────────────────────────────────────────────────

export interface SessionInfo {
  /** `null` pour une session legacy (aucune identité portée). */
  userId: string | null;
  /** Epoch ms d'émission. */
  ts: number;
  legacy: boolean;
}

/**
 * Vérifie un cookie de session, quel que soit son format.
 * Retourne `null` si signature invalide, format inconnu ou session expirée.
 */
export function verifySessionCookie(value: string | undefined | null): SessionInfo | null {
  if (!value) return null;
  try {
    const lastDot = value.lastIndexOf('.');
    if (lastDot === -1) return null;

    const payload = value.substring(0, lastDot);
    const signature = value.substring(lastDot + 1);
    if (!signatureMatches(signature, sign(payload))) return null;

    // Signature valide → le payload est authentique, on peut le découper.
    const parts = payload.split(':');
    if (parts[0] !== 'domo') return null;

    let userId: string | null;
    let rawTs: string;
    if (parts.length === 3) {
      userId = parts[1];
      rawTs = parts[2];
      if (!userId) return null;
    } else if (parts.length === 2) {
      userId = null;
      rawTs = parts[1];
    } else {
      return null;
    }

    const ts = parseInt(rawTs, 10);
    if (!Number.isFinite(ts)) return null;
    if ((Date.now() - ts) / 1000 >= COOKIE_MAX_AGE) return null; // expirée

    return { userId, ts, legacy: userId === null };
  } catch {
    return null;
  }
}

// ─── API publique ──────────────────────────────────────────────────────

export function checkMagicToken(token: string): boolean {
  const expected = env.AUTH_TOKEN;
  if (!expected) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Session valide, sans se soucier de l'identité. Les routes qui re-vérifient
 *  elles-mêmes (SSE, portail) passent par ici et acceptent les DEUX formats. */
export function isAuthenticated(cookies: Cookies): boolean {
  return verifySessionCookie(cookies.get(COOKIE_NAME)) !== null;
}

/**
 * Pose le cookie de session. Avec un `userId`, émet le format identifié ;
 * sans (aucun administrateur déclaré), retombe sur le legacy anonyme — un
 * magasin d'utilisateurs vide ou illisible ne doit JAMAIS interdire l'entrée
 * à quelqu'un qui présente le bon AUTH_TOKEN.
 */
export function setSessionCookie(cookies: Cookies, userId?: string | null): void {
  cookies.set(COOKIE_NAME, userId ? createSessionCookie(userId) : createLegacyToken(), {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE
  });
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}
