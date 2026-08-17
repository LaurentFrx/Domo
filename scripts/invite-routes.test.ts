/**
 * Tests des routes d'invitation et du nouveau /auth.
 * Lance : node --experimental-strip-types --import ./scripts/register-env.mjs --test scripts/invite-routes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUTH_SECRET = 'secret-de-test-suffisamment-long';
process.env.AUTH_TOKEN = 'jeton-magique-de-test';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'invite-routes-'));
process.chdir(sandbox);

const store = await import('../src/lib/server/users-store.ts');
const { POST: inviter, DELETE: revoquer } =
  await import('../src/routes/api/users/invite/+server.ts');
const { GET: authGet } = await import('../src/routes/auth/+server.ts');

const USERS_FILE = path.join(sandbox, 'data', 'users.json');
const admin = await store.createUser({ email: 'chef@exemple.fr', role: 'admin', status: 'active' });
const membre = await store.createUser({
  email: 'ex@exemple.fr',
  role: 'famille',
  status: 'invited'
});

const SESSION_ADMIN = { user: { id: admin.id, email: admin.email, role: 'admin' } };
const SESSION_FAMILLE = { user: { id: membre.id, email: membre.email, role: 'famille' } };
const SESSION_LEGACY = { user: { id: 'legacy', email: null, role: 'famille' } };

function evt(body: unknown, locals: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals
  };
}

const lire = async (r: Response) =>
  (await r.json()) as { message?: string; path?: string; expiresAt?: number; email?: string };

/** Appelle GET /auth et rend ce qui a été jeté (redirect ou error) + le cookie posé. */
async function auth(k: string) {
  const poses: Array<{ name: string; value: string }> = [];
  const event = {
    url: new URL(`http://localhost/auth?k=${encodeURIComponent(k)}`),
    cookies: { set: (name: string, value: string) => poses.push({ name, value }) }
  };
  try {
    await authGet(event as never);
    return { statut: 0, location: null as string | null, poses };
  } catch (e) {
    const jete = e as { status?: number; location?: string };
    return { statut: jete.status ?? -1, location: jete.location ?? null, poses };
  }
}

const userIdDuCookie = (v: string) => {
  const payload = v.slice(0, v.lastIndexOf('.')).split(':');
  return payload.length === 3 ? payload[1] : null;
};

// ─── POST /api/users/invite ────────────────────────────────────────────

test('admin : émet un lien, renvoie le jeton UNE fois', async () => {
  const r = await inviter(evt({ userId: membre.id }, SESSION_ADMIN) as never);
  assert.equal(r.status, 200);
  const d = await lire(r);
  assert.equal(d.email, 'ex@exemple.fr');
  assert.match(d.path as string, /^\/auth\?k=[A-Za-z0-9_-]{43}$/);
  assert.ok((d.expiresAt as number) > Date.now());
  // Le jeton n'est PAS retrouvable dans le magasin.
  const fichier = await fs.readFile(USERS_FILE, 'utf-8');
  const token = (d.path as string).split('k=')[1];
  assert.ok(!fichier.includes(token), 'le jeton en clair est stocké');
});

test('un membre « famille » ne peut pas inviter → 403', async () => {
  const r = await inviter(evt({ userId: admin.id }, SESSION_FAMILLE) as never);
  assert.equal(r.status, 403);
});

test('session legacy → 401 ; sans session → 401', async () => {
  assert.equal((await inviter(evt({ userId: membre.id }, SESSION_LEGACY) as never)).status, 401);
  assert.equal((await inviter(evt({ userId: membre.id }, {}) as never)).status, 401);
});

test('userId manquant → 400 ; inconnu → 404', async () => {
  assert.equal((await inviter(evt({}, SESSION_ADMIN) as never)).status, 400);
  assert.equal((await inviter(evt({ userId: 'fantome' }, SESSION_ADMIN) as never)).status, 404);
});

test('ttlDays hors bornes → 400, dans les bornes → respecté', async () => {
  for (const ttlDays of [0, 31, -3, 'sept', Number.NaN]) {
    assert.equal(
      (await inviter(evt({ userId: membre.id, ttlDays }, SESSION_ADMIN) as never)).status,
      400,
      `ttlDays=${ttlDays} aurait dû être refusé`
    );
  }
  const r = await inviter(evt({ userId: membre.id, ttlDays: 2 }, SESSION_ADMIN) as never);
  assert.equal(r.status, 200);
  const jours = ((await lire(r)).expiresAt! - Date.now()) / 86_400_000;
  assert.ok(jours > 1.9 && jours < 2.1, `durée inattendue : ${jours} j`);
});

test('inviter un compte révoqué → 409 (le réactiver d’abord)', async () => {
  const banni = await store.createUser({ email: 'parti@exemple.fr', role: 'famille' });
  const j = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  j.users = j.users.map((u: { id: string }) =>
    u.id === banni.id ? { ...u, status: 'revoked' } : u
  );
  await fs.writeFile(USERS_FILE, JSON.stringify(j, null, 2));
  const futur = new Date(Date.now() + 3000);
  await fs.utimes(USERS_FILE, futur, futur);

  const r = await inviter(evt({ userId: banni.id }, SESSION_ADMIN) as never);
  assert.equal(r.status, 409);
});

test('DELETE révoque le lien ; réservé à l’admin', async () => {
  const d = await lire(await inviter(evt({ userId: membre.id }, SESSION_ADMIN) as never));
  const token = (d.path as string).split('k=')[1];
  assert.ok(await store.findUserByInviteToken(token));

  assert.equal((await revoquer(evt({ userId: membre.id }, SESSION_FAMILLE) as never)).status, 403);
  assert.equal((await revoquer(evt({ userId: membre.id }, SESSION_ADMIN) as never)).status, 200);
  assert.equal(await store.findUserByInviteToken(token), null);
});

// ─── GET /auth ─────────────────────────────────────────────────────────

test('invitation : ouvre une session AU NOM de l’invité, pas de l’admin', async () => {
  const d = await lire(await inviter(evt({ userId: membre.id }, SESSION_ADMIN) as never));
  const token = (d.path as string).split('k=')[1];

  const r = await auth(token);
  assert.equal(r.statut, 303);
  assert.equal(r.location, '/');
  assert.equal(r.poses.length, 1);
  assert.equal(
    userIdDuCookie(r.poses[0].value),
    membre.id,
    'la session n’est pas celle de l’invité'
  );
  // Et l'entrée a fait passer le compte de « invited » à « active ».
  assert.equal((await store.findUserById(membre.id))?.status, 'active');
});

test('le lien survit à un aperçu SMS : deux ouvertures fonctionnent', async () => {
  const d = await lire(await inviter(evt({ userId: membre.id }, SESSION_ADMIN) as never));
  const token = (d.path as string).split('k=')[1];
  assert.equal((await auth(token)).statut, 303, 'ouverture par le robot d’aperçu');
  const humain = await auth(token);
  assert.equal(humain.statut, 303, 'la personne trouve un lien mort');
  assert.equal(userIdDuCookie(humain.poses[0].value), membre.id);
});

test('AUTH_TOKEN reste la trappe de secours → session admin', async () => {
  const r = await auth('jeton-magique-de-test');
  assert.equal(r.statut, 303);
  assert.equal(userIdDuCookie(r.poses[0].value), admin.id);
});

test('jeton inconnu, vide ou périmé → 403 et AUCUN cookie', async () => {
  for (const k of ['', 'nimportequoi', 'x'.repeat(43)]) {
    const r = await auth(k);
    assert.equal(r.statut, 403, `« ${k} » aurait dû être refusé`);
    assert.equal(r.poses.length, 0);
  }

  const d = await lire(await inviter(evt({ userId: membre.id }, SESSION_ADMIN) as never));
  const token = (d.path as string).split('k=')[1];
  const j = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  j.users = j.users.map((u: { id: string }) =>
    u.id === membre.id ? { ...u, inviteExpiresAt: Date.now() - 1000 } : u
  );
  await fs.writeFile(USERS_FILE, JSON.stringify(j, null, 2));
  const futur = new Date(Date.now() + 6000);
  await fs.utimes(USERS_FILE, futur, futur);

  const perime = await auth(token);
  assert.equal(perime.statut, 403, 'un lien périmé ouvre encore');
  assert.equal(perime.poses.length, 0);
});
