/**
 * Tests du magasin utilisateurs.
 * Lance : node --experimental-strip-types --test scripts/users-store.test.ts
 *
 * `users-store` résout `data/users.json` depuis `process.cwd()` AU CHARGEMENT du
 * module : on bascule donc dans un répertoire temporaire AVANT de l'importer,
 * pour ne jamais toucher au vrai fichier.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'users-store-'));
process.chdir(sandbox);

const store = await import('../src/lib/server/users-store.ts');
const USERS_FILE = path.join(sandbox, 'data', 'users.json');

test('fichier absent → liste vide, aucun administrateur', async () => {
  assert.deepEqual(await store.readUsers(), []);
  assert.equal(await store.findActiveAdmin(), null);
});

test('createUser pose le schéma complet, PIN à null', async () => {
  const u = await store.createUser({ email: 'a@exemple.fr', role: 'admin', status: 'active' });
  assert.match(u.id, /^[0-9a-f-]{36}$/);
  assert.equal(u.email, 'a@exemple.fr');
  assert.equal(u.role, 'admin');
  assert.equal(u.status, 'active');
  assert.equal(u.pinHash, null);
  assert.equal(u.pinSalt, null);
  assert.equal(u.pinAttempts, 0);
  assert.equal(u.pinLockedUntil, null);
  assert.equal(u.lastLoginAt, null);
  assert.ok(!Number.isNaN(Date.parse(u.createdAt)));
});

test('le fichier écrit est versionné et relisible', async () => {
  const raw = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.users.length, 1);
});

test('doublon d’email refusé (casse ignorée)', async () => {
  await assert.rejects(() => store.createUser({ email: 'A@Exemple.fr', role: 'famille' }));
});

test('findActiveAdmin ne renvoie que l’admin ACTIF', async () => {
  const fam = await store.createUser({ email: 'b@exemple.fr', role: 'famille', status: 'active' });
  const admin = await store.findActiveAdmin();
  assert.equal(admin?.email, 'a@exemple.fr');
  assert.equal((await store.findUserById(fam.id))?.role, 'famille');
  assert.equal((await store.findUserByEmail('B@EXEMPLE.FR'))?.id, fam.id);
});

test('touchLastLogin horodate, et le cache voit l’écriture', async () => {
  const admin = (await store.findActiveAdmin())!;
  assert.equal(admin.lastLoginAt, null);
  await store.touchLastLogin(admin.id);
  const relu = await store.findUserById(admin.id);
  assert.ok(relu?.lastLoginAt, 'lastLoginAt doit être renseigné');
  assert.ok(!Number.isNaN(Date.parse(relu.lastLoginAt as string)));
});

test('id inconnu → null, et touchLastLogin ne jette pas', async () => {
  assert.equal(await store.findUserById('inexistant'), null);
  await store.touchLastLogin('inexistant');
});

// ─── Amortissement de lastLoginAt ──────────────────────────────────────
// Un appelant répétitif sur /auth (crontab, prefetch, raccourci) ne doit pas
// déclencher une écriture durable à chaque passage. Régression vécue en prod :
// ~1440 écritures/jour pendant neuf jours.

test('un second passage dans l’heure n’écrit PAS le fichier', async () => {
  const admin = (await store.findActiveAdmin())!;
  const avant = await fs.stat(USERS_FILE);
  const dateAvant = admin.lastLoginAt;

  for (let i = 0; i < 5; i++) await store.touchLastLogin(admin.id);

  const apres = await fs.stat(USERS_FILE);
  assert.equal(apres.mtimeMs, avant.mtimeMs, 'le fichier a été réécrit alors qu’il ne devait pas');
  assert.equal((await store.findUserById(admin.id))?.lastLoginAt, dateAvant, 'la date a bougé');
});

test('au-delà de la granularité, l’horodatage repart', async () => {
  const admin = (await store.findActiveAdmin())!;
  const vieux = new Date(Date.now() - store.LAST_LOGIN_GRANULARITE_MS - 60_000).toISOString();
  const raw = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  raw.users = raw.users.map((u: { id: string }) =>
    u.id === admin.id ? { ...u, lastLoginAt: vieux } : u
  );
  await fs.writeFile(USERS_FILE, JSON.stringify(raw, null, 2));
  const futur = new Date(Date.now() + 2000);
  await fs.utimes(USERS_FILE, futur, futur);

  await store.touchLastLogin(admin.id);
  const relu = await store.findUserById(admin.id);
  assert.notEqual(relu?.lastLoginAt, vieux, 'la date aurait dû être rafraîchie');
  assert.ok(Date.parse(relu?.lastLoginAt as string) > Date.parse(vieux));
});

test('lastLoginAt illisible → on réécrit plutôt que de rester coincé', async () => {
  const admin = (await store.findActiveAdmin())!;
  const raw = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  raw.users = raw.users.map((u: { id: string }) =>
    u.id === admin.id ? { ...u, lastLoginAt: 'pas-une-date' } : u
  );
  await fs.writeFile(USERS_FILE, JSON.stringify(raw, null, 2));
  const futur = new Date(Date.now() + 4000);
  await fs.utimes(USERS_FILE, futur, futur);

  await store.touchLastLogin(admin.id);
  const relu = await store.findUserById(admin.id);
  assert.ok(!Number.isNaN(Date.parse(relu?.lastLoginAt as string)), 'date toujours illisible');
});

test('édition MANUELLE du fichier prise en compte (révocation sans UI)', async () => {
  const admin = (await store.findActiveAdmin())!;
  const raw = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  raw.users = raw.users.map((u: { id: string }) =>
    u.id === admin.id ? { ...u, status: 'revoked' } : u
  );
  // mtime à la seconde près sur certains FS : on force un horodatage distinct.
  await fs.writeFile(USERS_FILE, JSON.stringify(raw, null, 2));
  const future = new Date(Date.now() + 2000);
  await fs.utimes(USERS_FILE, future, future);

  assert.equal(await store.findActiveAdmin(), null, 'le compte révoqué ne doit plus être admin');
  assert.equal((await store.findUserById(admin.id))?.status, 'revoked');
});

test('entrée malformée écartée sans faire tomber le reste', async () => {
  const raw = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  const avant = raw.users.length;
  raw.users.push({ id: 'x', email: 'sans-role@exemple.fr' }); // role/status manquants
  await fs.writeFile(USERS_FILE, JSON.stringify(raw, null, 2));
  const future = new Date(Date.now() + 4000);
  await fs.utimes(USERS_FILE, future, future);

  assert.equal((await store.readUsers()).length, avant);
});
