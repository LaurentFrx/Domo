/**
 * Auth magic link — server-only.
 *
 * Stratégie :
 *   - Lien magique permanent : /auth?k=<AUTH_TOKEN>
 *   - Un clic pose un cookie httpOnly signé HMAC-SHA256 (1 an)
 *   - Pas de mot de passe, pas de formulaire
 *   - Partager le lien par SMS/WhatsApp, c'est tout
 */

import { env } from '$env/dynamic/private';
import crypto from 'node:crypto';

const COOKIE_NAME = 'domo_session';
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

function createSessionToken(): string {
  const payload = `domo:${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token: string): boolean {
  try {
    const lastDot = token.lastIndexOf('.');
    if (lastDot === -1) return false;

    const payload = token.substring(0, lastDot);
    const signature = token.substring(lastDot + 1);

    const expected = sign(payload);
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
      return false;
    }

    // Vérifier expiration
    const timestamp = parseInt(payload.split(':')[1], 10);
    return (Date.now() - timestamp) / 1000 < COOKIE_MAX_AGE;
  } catch {
    return false;
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

export function isAuthenticated(cookies: { get: (name: string) => string | undefined }): boolean {
  const token = cookies.get(COOKIE_NAME);
  if (!token) return false;
  return verifySessionToken(token);
}

export function setSessionCookie(cookies: {
  set: (name: string, value: string, opts: Record<string, unknown>) => void;
}): void {
  cookies.set(COOKIE_NAME, createSessionToken(), {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE
  });
}

export function clearSessionCookie(cookies: {
  delete: (name: string, opts: Record<string, unknown>) => void;
}): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}
