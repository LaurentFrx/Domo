/**
 * Tests de l'administration des comptes (/api/users).
 * Lance : node --experimental-strip-types --import ./scripts/register-env.mjs --test scripts/users-admin.test.ts
 *
 * Le cas qui compte le plus : ne JAMAIS pouvoir se retrouver sans administrateur
 * actif. Sans ce garde-fou, une fausse manœuvre rendrait l'administration
 * inatteignable depuis l'app, et il faudrait rouvrir users.json sur le VPS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUTH_SECRET = 'secret-de-test-suffisamment-long';
process.env.AUTH_TOKEN = 'jeton-magique-de-test';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'users-admin-'));
process.chdir(sandbox);

const store = await import('../src/lib/server/users-store.ts');
const api = await import('../src/routes/api/users/+server.ts');
const { POST: inviter } = await import('../src/routes/api/users/invite/+server.ts');

const admin = await store.createUser({ email: 'chef@exemple.fr', role: 'admin', status: 'active' });
const membre = await store.createUser({
  email: 'ex@exemple.fr',
  role: 'famille',
  status: 'active'
});

const SESSION_ADMIN = { user: { id: admin.id, email: admin.email, role: 'admin' } };
const SESSION_FAMILLE = { user: { id: membre.id, email: membre.email, role: 'famille' } };
const SESSION_LEGACY = { user: { id: 'legacy', email: null, role: 'famille' } };

function evt(body: unknown, locals: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals
  };
}

const lire = async (r: Response) => (await r.json()) as Record<string, unknown>;

// ─── Accès ─────────────────────────────────────────────────────────────

test('la liste est réservée à l’admin', async () => {
  assert.equal((await api.GET({ locals: SESSION_ADMIN } as never)).status, 200);
  assert.equal((await api.GET({ locals: SESSION_FAMILLE } as never)).status, 403);
  assert.equal((await api.GET({ locals: SESSION_LEGACY } as never)).status, 401);
  assert.equal((await api.GET({ locals: {} } as never)).status, 401);
});

test('toutes les écritures sont réservées à l’admin', async () => {
  for (const [nom, fn] of [
    ['POST', api.POST],
    ['PATCH', api.PATCH],
    ['DELETE', api.DELETE]
  ] as const) {
    assert.equal(
      (await fn(evt({ userId: membre.id, email: 'x@y.fr' }, SESSION_FAMILLE) as never)).status,
      403,
      `${nom} laisse passer un membre famille`
    );
  }
});

test('la liste ne laisse fuir NI empreinte de code, NI empreinte de lien', async () => {
  await store.setUserPin(membre.id, '1234');
  await store.issueInvite(membre.id);
  const d = await lire(await api.GET({ locals: SESSION_ADMIN } as never));
  const texte = JSON.stringify(d);
  assert.ok(!/[0-9a-f]{64}/.test(texte), 'une empreinte sort de l’API');
  assert.ok(!texte.includes('pinSalt'), 'le sel sort de l’API');
  const u = (d.users as Array<Record<string, unknown>>).find((x) => x.id === membre.id)!;
  assert.equal(u.aUnCode, true);
  assert.ok(u.invitation, 'l’existence du lien doit être visible');
});

// ─── Création ──────────────────────────────────────────────────────────

test('POST crée un compte « invité », adresse invalide → 400, doublon → 409', async () => {
  const r = await api.POST(evt({ email: 'neuf@exemple.fr' }, SESSION_ADMIN) as never);
  assert.equal(r.status, 200);
  const cree = (await lire(r)).user as { id: string; role: string };
  assert.equal(cree.role, 'famille', 'rôle par défaut');
  assert.equal((await store.findUserById(cree.id))?.status, 'invited');

  assert.equal(
    (await api.POST(evt({ email: 'pas-une-adresse' }, SESSION_ADMIN) as never)).status,
    400
  );
  assert.equal(
    (await api.POST(evt({ email: 'NEUF@exemple.fr' }, SESSION_ADMIN) as never)).status,
    409
  );
});

// ─── Rôle et statut ────────────────────────────────────────────────────

test('PATCH change le rôle et le statut ; valeurs inconnues → 400', async () => {
  assert.equal(
    (await api.PATCH(evt({ userId: membre.id, role: 'admin' }, SESSION_ADMIN) as never)).status,
    200
  );
  assert.equal((await store.findUserById(membre.id))?.role, 'admin');
  assert.equal(
    (await api.PATCH(evt({ userId: membre.id, role: 'famille' }, SESSION_ADMIN) as never)).status,
    200
  );
  assert.equal(
    (await api.PATCH(evt({ userId: membre.id, role: 'roi' }, SESSION_ADMIN) as never)).status,
    400
  );
  assert.equal(
    (await api.PATCH(evt({ userId: membre.id, status: 'zombie' }, SESSION_ADMIN) as never)).status,
    400
  );
  assert.equal((await api.PATCH(evt({ role: 'admin' }, SESSION_ADMIN) as never)).status, 400);
  assert.equal(
    (await api.PATCH(evt({ userId: 'fantome', role: 'admin' }, SESSION_ADMIN) as never)).status,
    404
  );
});

test('couper l’accès désactive AUSSI le lien d’invitation', async () => {
  const d = await lire(await inviter(evt({ userId: membre.id }, SESSION_ADMIN) as never));
  const token = (d.path as string).split('k=')[1];
  assert.ok(await store.findUserByInviteToken(token));

  await api.PATCH(evt({ userId: membre.id, status: 'revoked' }, SESSION_ADMIN) as never);
  assert.equal(await store.findUserByInviteToken(token), null, 'le lien survit à la coupure');

  await api.PATCH(evt({ userId: membre.id, status: 'active' }, SESSION_ADMIN) as never);
  assert.equal(
    await store.findUserByInviteToken(token),
    null,
    'le lien ressuscite à la réactivation'
  );
});

// ─── Garde-fou d'enfermement ───────────────────────────────────────────

test('se rétrograder quand on est le SEUL admin → 409', async () => {
  const r = await api.PATCH(evt({ userId: admin.id, role: 'famille' }, SESSION_ADMIN) as never);
  assert.equal(r.status, 409);
  assert.equal((await lire(r)).error, 'dernier_admin');
  assert.equal((await store.findUserById(admin.id))?.role, 'admin', 'le rôle a quand même changé');
});

test('se révoquer quand on est le SEUL admin → 409', async () => {
  const r = await api.PATCH(evt({ userId: admin.id, status: 'revoked' }, SESSION_ADMIN) as never);
  assert.equal(r.status, 409);
  assert.equal((await store.findUserById(admin.id))?.status, 'active');
});

test('supprimer le DERNIER admin → 409', async () => {
  const r = await api.DELETE(evt({ userId: admin.id }, SESSION_ADMIN) as never);
  assert.equal(r.status, 409);
  assert.ok(await store.findUserById(admin.id), 'l’admin a été supprimé');
});

test('avec un SECOND admin, tout redevient possible', async () => {
  await api.PATCH(evt({ userId: membre.id, role: 'admin' }, SESSION_ADMIN) as never);
  assert.equal(
    (await api.PATCH(evt({ userId: admin.id, role: 'famille' }, SESSION_ADMIN) as never)).status,
    200
  );
  assert.equal((await store.findUserById(admin.id))?.role, 'famille');
  // On remet l'ancien admin en place pour la suite.
  await api.PATCH(evt({ userId: admin.id, role: 'admin' }, SESSION_ADMIN) as never);
});

test('DELETE supprime réellement quand ce n’est pas le dernier admin', async () => {
  const jetable = await store.createUser({ email: 'jetable@exemple.fr', role: 'famille' });
  assert.equal((await api.DELETE(evt({ userId: jetable.id }, SESSION_ADMIN) as never)).status, 200);
  assert.equal(await store.findUserById(jetable.id), null);
  // Supprimer deux fois ne casse rien.
  assert.equal((await api.DELETE(evt({ userId: jetable.id }, SESSION_ADMIN) as never)).status, 200);
});
