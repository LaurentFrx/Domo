/**
 * Tests de `attemptPinLogin` — la vraie protection du PIN à 4 chiffres.
 * Lance : node --experimental-strip-types --test scripts/pin-login.test.ts
 *
 * Comme pour users-store.test.ts, on bascule dans un répertoire temporaire
 * AVANT d'importer le module (il résout `data/users.json` depuis le cwd).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'pin-login-'));
process.chdir(sandbox);

const store = await import('../src/lib/server/users-store.ts');
const USERS_FILE = path.join(sandbox, 'data', 'users.json');

const EMAIL = 'Chef@Exemple.fr'; // casse volontairement mélangée
const PIN = '4271';

const admin = await store.createUser({ email: EMAIL, role: 'admin', status: 'active' });
const autre = await store.createUser({ email: 'ex@exemple.fr', role: 'famille', status: 'active' });

/** Lit le fichier brut (hors cache) pour inspecter les compteurs. */
async function brut(id: string) {
  const j = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  return j.users.find((u: { id: string }) => u.id === id);
}

/** Réécrit un champ et force un mtime distinct (le cache du magasin s'y fie). */
async function patch(id: string, champs: Record<string, unknown>) {
  const j = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  j.users = j.users.map((u: { id: string }) => (u.id === id ? { ...u, ...champs } : u));
  await fs.writeFile(USERS_FILE, JSON.stringify(j, null, 2));
  const futur = new Date(Date.now() + 3000);
  await fs.utimes(USERS_FILE, futur, futur);
}

test('aucun PIN défini → no_pin', async () => {
  const r = await store.attemptPinLogin(EMAIL, PIN);
  assert.deepEqual(r, { ok: false, reason: 'no_pin' });
});

test('setUserPin pose l’empreinte et remet les compteurs à zéro', async () => {
  await store.setUserPin(admin.id, PIN);
  const u = await brut(admin.id);
  assert.match(u.pinHash, /^[0-9a-f]{64}$/);
  assert.match(u.pinSalt, /^[0-9a-f]{32}$/);
  assert.equal(u.pinAttempts, 0);
  assert.equal(u.pinLockedUntil, null);
});

test('email inconnu → not_found', async () => {
  assert.deepEqual(await store.attemptPinLogin('personne@exemple.fr', PIN), {
    ok: false,
    reason: 'not_found'
  });
});

test('bon code, casse de l’email ignorée → succès + lastLoginAt', async () => {
  const r = await store.attemptPinLogin('CHEF@EXEMPLE.FR', PIN);
  assert.deepEqual(r, { ok: true, userId: admin.id });
  const u = await brut(admin.id);
  assert.equal(u.pinAttempts, 0);
  assert.equal(u.pinLockedUntil, null);
  assert.ok(u.lastLoginAt, 'lastLoginAt doit être renseigné');
});

test('mauvais code : le compteur monte, puis verrou au 3e', async () => {
  for (const attendu of [1, 2]) {
    const r = await store.attemptPinLogin(EMAIL, '0000');
    assert.deepEqual(r, { ok: false, reason: 'wrong_pin' });
    const u = await brut(admin.id);
    assert.equal(u.pinAttempts, attendu);
    assert.equal(u.pinLockedUntil, null, 'pas de verrou avant le 3e essai');
  }
  const r3 = await store.attemptPinLogin(EMAIL, '0000');
  assert.deepEqual(r3, { ok: false, reason: 'wrong_pin' });
  const u = await brut(admin.id);
  assert.equal(u.pinAttempts, store.PIN_MAX_ATTEMPTS);
  assert.ok(u.pinLockedUntil > Date.now(), 'le verrou doit être posé');
});

test('pendant le verrou : même le BON code est refusé', async () => {
  const r = await store.attemptPinLogin(EMAIL, PIN);
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'locked');
  const restant = (r as { retryAfterMs: number }).retryAfterMs;
  assert.ok(restant > 0 && restant <= store.PIN_LOCK_MS, `retryAfterMs incohérent : ${restant}`);
});

test('un essai pendant le verrou ne repousse PAS l’échéance', async () => {
  const avant = (await brut(admin.id)).pinLockedUntil;
  await store.attemptPinLogin(EMAIL, '1111');
  await store.attemptPinLogin(EMAIL, '2222');
  const apres = await brut(admin.id);
  assert.equal(apres.pinLockedUntil, avant, 'l’échéance a bougé');
  assert.equal(apres.pinAttempts, store.PIN_MAX_ATTEMPTS, 'le compteur a bougé');
});

test('verrou expiré → 3 essais neufs, pas un reverrouillage immédiat', async () => {
  await patch(admin.id, { pinLockedUntil: Date.now() - 1000 });
  const r = await store.attemptPinLogin(EMAIL, '0000');
  assert.deepEqual(r, { ok: false, reason: 'wrong_pin' });
  const u = await brut(admin.id);
  assert.equal(u.pinAttempts, 1, 'le compteur doit repartir de zéro après expiration');
  assert.equal(u.pinLockedUntil, null, 'pas de reverrouillage au premier faux essai');
});

test('succès après expiration → tout est remis à zéro', async () => {
  const r = await store.attemptPinLogin(EMAIL, PIN);
  assert.deepEqual(r, { ok: true, userId: admin.id });
  const u = await brut(admin.id);
  assert.equal(u.pinAttempts, 0);
  assert.equal(u.pinLockedUntil, null);
});

test('compte révoqué → not_found (et non « mauvais code »)', async () => {
  await store.setUserPin(autre.id, '8888');
  await patch(autre.id, { status: 'revoked' });
  assert.deepEqual(await store.attemptPinLogin('ex@exemple.fr', '8888'), {
    ok: false,
    reason: 'not_found'
  });
});

test('essais SIMULTANÉS : le verrou de fichier empêche de perdre des incréments', async () => {
  await store.setUserPin(admin.id, PIN); // repart propre
  const résultats = await Promise.all([
    store.attemptPinLogin(EMAIL, '0001'),
    store.attemptPinLogin(EMAIL, '0002'),
    store.attemptPinLogin(EMAIL, '0003')
  ]);
  assert.ok(résultats.every((r) => r.ok === false));
  const u = await brut(admin.id);
  // Sans withFileLock, les trois liraient pinAttempts=0 et écriraient 1.
  assert.equal(u.pinAttempts, 3, 'des incréments ont été perdus');
  assert.ok(u.pinLockedUntil > Date.now(), 'le verrou aurait dû se déclencher');
});
