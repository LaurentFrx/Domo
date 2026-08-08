/**
 * Tests du cookie de session — cohabitation des DEUX formats.
 * Lance : node --experimental-strip-types --import ./scripts/register-env.mjs --test scripts/auth-session.test.ts
 *
 * L'enjeu : les cookies posés sur les iPhone de la famille valent un an et sont
 * au format anonyme `domo:<ts>.<hmac>`. La phase identité ne doit mettre
 * personne dehors. Ces tests sont là pour qu'une refonte future ne le casse pas
 * en silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// AVANT l'import du module testé : le stub `$env/dynamic/private` lit process.env.
const SECRET = 'secret-de-test-suffisamment-long';
process.env.AUTH_SECRET = SECRET;
process.env.AUTH_TOKEN = 'jeton-magique-de-test';

const { createSessionCookie, verifySessionCookie, isAuthenticated, checkMagicToken } =
  await import('../src/lib/server/auth.ts');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Reconstruit un cookie à l'ANCIEN format, tel qu'il existe déjà en production. */
function legacyCookie(ts = Date.now()): string {
  const payload = `domo:${ts}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

/** Faux `Cookies` de SvelteKit : seul `get` est utilisé par isAuthenticated. */
function fakeCookies(value: string | undefined) {
  return { get: (name: string) => (name === 'domo_session' ? value : undefined) } as never;
}

// ─── Format legacy (2 segments) ────────────────────────────────────────

test('legacy : un cookie anonyme déjà posé reste valide', () => {
  const info = verifySessionCookie(legacyCookie());
  assert.ok(info, 'le cookie legacy doit être accepté');
  assert.equal(info.legacy, true);
  assert.equal(info.userId, null);
});

test('legacy : isAuthenticated continue de le laisser passer', () => {
  assert.equal(isAuthenticated(fakeCookies(legacyCookie())), true);
});

test('legacy : expiré au-delà d’un an → refusé', () => {
  const vieux = legacyCookie(Date.now() - ONE_YEAR_MS - 60_000);
  assert.equal(verifySessionCookie(vieux), null);
});

// ─── Format identifié (3 segments) ─────────────────────────────────────

test('identifié : aller-retour createSessionCookie → verifySessionCookie', () => {
  const id = crypto.randomUUID();
  const info = verifySessionCookie(createSessionCookie(id));
  assert.ok(info);
  assert.equal(info.legacy, false);
  assert.equal(info.userId, id);
  assert.ok(Math.abs(Date.now() - info.ts) < 5_000);
});

test('identifié : le format posé est bien domo:<userId>:<ts>.<hmac>', () => {
  const id = crypto.randomUUID();
  const cookie = createSessionCookie(id);
  const [payload, sig] = [cookie.slice(0, cookie.lastIndexOf('.')), cookie.split('.').pop()];
  assert.deepEqual(payload.split(':').length, 3);
  assert.equal(payload.split(':')[0], 'domo');
  assert.equal(payload.split(':')[1], id);
  assert.match(sig as string, /^[0-9a-f]{64}$/);
});

test('identifié : isAuthenticated l’accepte aussi', () => {
  assert.equal(isAuthenticated(fakeCookies(createSessionCookie(crypto.randomUUID()))), true);
});

// ─── Falsifications ────────────────────────────────────────────────────

test('changer l’userId invalide la signature (pas d’usurpation)', () => {
  const cookie = createSessionCookie(crypto.randomUUID());
  const falsifie = cookie.replace(/^domo:[^:]+:/, `domo:${crypto.randomUUID()}:`);
  assert.equal(verifySessionCookie(falsifie), null);
});

test('signature tronquée ou bricolée → refusé', () => {
  const cookie = createSessionCookie(crypto.randomUUID());
  assert.equal(verifySessionCookie(cookie.slice(0, -4)), null);
  assert.equal(verifySessionCookie(`${cookie}ff`), null);
});

test('cookie signé avec un AUTRE secret → refusé', () => {
  const payload = `domo:${crypto.randomUUID()}:${Date.now()}`;
  const hmac = crypto
    .createHmac('sha256', 'un-tout-autre-secret-long')
    .update(payload)
    .digest('hex');
  assert.equal(verifySessionCookie(`${payload}.${hmac}`), null);
});

test('formes dégénérées → refusé, jamais de jet', () => {
  for (const v of ['', undefined, null, 'nimportequoi', 'domo:1.', '.abc', 'a:b:c:d.ff']) {
    assert.equal(verifySessionCookie(v as string), null, `refus attendu pour ${JSON.stringify(v)}`);
  }
  assert.equal(isAuthenticated(fakeCookies(undefined)), false);
});

test('un préfixe autre que « domo » est refusé même bien signé', () => {
  const payload = `autre:${Date.now()}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  assert.equal(verifySessionCookie(`${payload}.${hmac}`), null);
});

// ─── Le lien magique reste intact ──────────────────────────────────────

test('checkMagicToken inchangé : bon jeton accepté, mauvais refusé', () => {
  assert.equal(checkMagicToken('jeton-magique-de-test'), true);
  assert.equal(checkMagicToken('mauvais'), false);
  assert.equal(checkMagicToken(''), false);
});
