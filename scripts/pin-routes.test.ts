/**
 * Tests des routes de PIN, handlers appelés directement.
 * Lance : node --experimental-strip-types --import ./scripts/register-env.mjs --test scripts/pin-routes.test.ts
 *
 * L'enjeu principal : /api/auth/pin-login ne doit JAMAIS laisser deviner si une
 * adresse existe dans le magasin. Compte inconnu, PIN non défini et mauvais code
 * doivent être rigoureusement indiscernables de l'extérieur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUTH_SECRET = 'secret-de-test-suffisamment-long';
process.env.AUTH_TOKEN = 'jeton-magique-de-test';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'pin-routes-'));
process.chdir(sandbox);

const store = await import('../src/lib/server/users-store.ts');
const { POST: pinLogin } = await import('../src/routes/api/auth/pin-login/+server.ts');
const { POST: setPin } = await import('../src/routes/api/account/pin/+server.ts');

const USERS_FILE = path.join(sandbox, 'data', 'users.json');
const PIN = '4271';

const admin = await store.createUser({ email: 'chef@exemple.fr', role: 'admin', status: 'active' });
const membre = await store.createUser({
  email: 'ex@exemple.fr',
  role: 'famille',
  status: 'active'
});
// Compte volontairement SANS PIN : sert au test d'indiscernabilité des refus.
const sansPin = await store.createUser({
  email: 'muet@exemple.fr',
  role: 'famille',
  status: 'active'
});
await store.setUserPin(admin.id, PIN);
await store.setUserPin(membre.id, '1357');

/**
 * Faux RequestEvent réduit à ce que les handlers utilisent réellement.
 *
 * `ip` alimente `X-Forwarded-For` — c'est ainsi que Caddy présente l'appelant,
 * et donc ce que `clientKey()` retient. Par DÉFAUT chaque appel reçoit une IP
 * distincte : sans ça, la limite par appelant (10 / 15 min, état partagé au
 * niveau du module) finirait par répondre 429 aux tests qui n'ont rien à voir
 * avec elle. Le test dédié, lui, fixe l'IP exprès.
 */
let compteurIp = 0;
function evt(body: unknown, locals: Record<string, unknown> = {}, ip?: string) {
  const posés: Array<{ name: string; value: string }> = [];
  const adresse = ip ?? `203.0.113.${++compteurIp % 254}`;
  return {
    request: new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': adresse },
      body: JSON.stringify(body)
    }),
    cookies: { set: (name: string, value: string) => posés.push({ name, value }) },
    getClientAddress: () => '127.0.0.1',
    locals,
    posés
  };
}

const lire = async (r: Response) => (await r.json()) as { message?: string; redirect?: string };

async function patch(id: string, champs: Record<string, unknown>) {
  const j = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  j.users = j.users.map((u: { id: string }) => (u.id === id ? { ...u, ...champs } : u));
  await fs.writeFile(USERS_FILE, JSON.stringify(j, null, 2));
  const futur = new Date(Date.now() + 3000);
  await fs.utimes(USERS_FILE, futur, futur);
}

// ─── /api/auth/pin-login ───────────────────────────────────────────────

test('succès : 200, cookie identifié posé, redirection vers /', async () => {
  const e = evt({ email: 'chef@exemple.fr', pin: PIN });
  const r = await pinLogin(e as never);
  assert.equal(r.status, 200);
  assert.equal((await lire(r)).redirect, '/');
  assert.equal(e.posés.length, 1);
  assert.equal(e.posés[0].name, 'domo_session');
  const payload = e.posés[0].value.slice(0, e.posés[0].value.lastIndexOf('.'));
  assert.equal(payload.split(':').length, 3, 'cookie identifié attendu');
  assert.equal(payload.split(':')[1], admin.id);
});

test('les trois refus sont INDISCERNABLES', async () => {
  const cas = {
    inconnu: evt({ email: 'personne@exemple.fr', pin: '0000' }),
    sans_pin: evt({ email: 'muet@exemple.fr', pin: '0000' }),
    mauvais: evt({ email: 'chef@exemple.fr', pin: '0000' })
  };
  const vus: string[] = [];
  for (const [nom, e] of Object.entries(cas)) {
    const r = await pinLogin(e as never);
    const d = await lire(r);
    vus.push(`${r.status}|${d.message}`);
    assert.equal(e.posés.length, 0, `${nom} : aucun cookie ne doit être posé`);
  }
  assert.equal(new Set(vus).size, 1, `réponses distinctes : ${JSON.stringify(vus)}`);
  assert.match(vus[0], /^401\|Email ou code incorrect\.$/);
});

test('verrouillage : 429 + minutes restantes + en-tête retry-after', async () => {
  await store.setUserPin(membre.id, '1357');
  for (let i = 0; i < 3; i++) {
    await pinLogin(evt({ email: 'ex@exemple.fr', pin: '0000' }) as never);
  }
  const e = evt({ email: 'ex@exemple.fr', pin: '1357' }); // pourtant le BON code
  const r = await pinLogin(e as never);
  assert.equal(r.status, 429);
  assert.match((await lire(r)).message as string, /Réessaie dans 15 minutes\./);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal(e.posés.length, 0);
});

test('format invalide → 400, message générique lui aussi', async () => {
  for (const pin of ['12', '12345', 'abcd', '']) {
    const r = await pinLogin(evt({ email: 'chef@exemple.fr', pin }) as never);
    assert.equal(r.status, 400);
    assert.equal((await lire(r)).message, 'Email ou code incorrect.');
  }
});

test('corps vide ou email manquant → 400, sans jeter', async () => {
  assert.equal((await pinLogin(evt({}) as never)).status, 400);
  assert.equal((await pinLogin(evt({ pin: '1234' }) as never)).status, 400);
});

// ─── Limite par appelant (indépendante du verrou de compte) ────────────

test('limite par IP : 10 essais tolérés, le 11e est refusé — avec des emails DIFFÉRENTS', async () => {
  const IP = '198.51.100.7';
  // Des adresses toutes distinctes et inexistantes : aucun verrou de compte ne
  // peut se déclencher, ce qui isole bien la limite par appelant.
  for (let i = 1; i <= 10; i++) {
    const r = await pinLogin(
      evt({ email: `inconnu${i}@exemple.fr`, pin: '0000' }, {}, IP) as never
    );
    assert.equal(r.status, 401, `essai ${i} : la limite ne doit pas encore mordre`);
  }
  const r = await pinLogin(evt({ email: 'inconnu11@exemple.fr', pin: '0000' }, {}, IP) as never);
  assert.equal(r.status, 429);
  const d = await lire(r);
  assert.equal(d.message, 'Trop de tentatives, réessaie plus tard.');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('la limite est bien PAR appelant : une autre IP passe encore', async () => {
  const r = await pinLogin(
    evt({ email: 'inconnu@exemple.fr', pin: '0000' }, {}, '198.51.100.8') as never
  );
  assert.equal(r.status, 401, 'une IP voisine ne doit pas hériter du blocage');
});

test('IP bloquée : le magasin n’est même pas consulté (message distinct du verrou)', async () => {
  // Le compte existe et son code est bon : si la réponse était traitée, ce
  // serait un 200. Un 429 « trop de tentatives » prouve la sortie anticipée.
  const r = await pinLogin(
    evt({ email: 'chef@exemple.fr', pin: PIN }, {}, '198.51.100.7') as never
  );
  assert.equal(r.status, 429);
  assert.equal((await lire(r)).message, 'Trop de tentatives, réessaie plus tard.');
});

test('XFF forgé par le client : seule la DERNIÈRE entrée compte', async () => {
  // Caddy AJOUTE l'adresse réelle en fin de liste ; ce que le client a mis
  // devant est ignoré, sinon il changerait de seau à volonté.
  const e = evt({ email: 'inconnu@exemple.fr', pin: '0000' }, {}, '10.0.0.1, 198.51.100.7');
  const r = await pinLogin(e as never);
  assert.equal(r.status, 429, 'le seau retenu doit être celui de la dernière entrée');
});

// ─── /api/account/pin ──────────────────────────────────────────────────

test('session legacy → 401 (le PIN exige une identité)', async () => {
  const r = await setPin(
    evt({ pin: '1122' }, { user: { id: 'legacy', role: 'famille' } }) as never
  );
  assert.equal(r.status, 401);
});

test('sans session → 401', async () => {
  assert.equal((await setPin(evt({ pin: '1122' }, {}) as never)).status, 401);
});

test('self-service : un membre pose son propre code', async () => {
  const r = await setPin(
    evt(
      { pin: '2244' },
      { user: { id: membre.id, email: 'ex@exemple.fr', role: 'famille' } }
    ) as never
  );
  assert.equal(r.status, 200);
  // Poser un code neuf lève aussi le verrou du test précédent.
  assert.deepEqual(await store.attemptPinLogin('ex@exemple.fr', '2244'), {
    ok: true,
    userId: membre.id
  });
});

test('un membre NE PEUT PAS poser le code d’un autre → 403', async () => {
  const r = await setPin(
    evt(
      { pin: '3355', userId: admin.id },
      { user: { id: membre.id, email: 'ex@exemple.fr', role: 'famille' } }
    ) as never
  );
  assert.equal(r.status, 403);
  // Le code de l'admin est intact.
  assert.deepEqual(await store.attemptPinLogin('chef@exemple.fr', PIN), {
    ok: true,
    userId: admin.id
  });
});

test('un admin peut poser le code d’un autre', async () => {
  const r = await setPin(
    evt(
      { pin: '4466', userId: membre.id },
      { user: { id: admin.id, email: 'chef@exemple.fr', role: 'admin' } }
    ) as never
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await store.attemptPinLogin('ex@exemple.fr', '4466'), {
    ok: true,
    userId: membre.id
  });
});

test('format invalide → 400 ; cible inconnue → 404', async () => {
  const admin_ = { user: { id: admin.id, email: 'chef@exemple.fr', role: 'admin' } };
  assert.equal((await setPin(evt({ pin: '12' }, admin_) as never)).status, 400);
  assert.equal(
    (await setPin(evt({ pin: '1234', userId: 'fantome' }, admin_) as never)).status,
    404
  );
});

test('la réponse ne renvoie jamais le code ni l’empreinte', async () => {
  const r = await setPin(
    evt(
      { pin: '7788' },
      { user: { id: admin.id, email: 'chef@exemple.fr', role: 'admin' } }
    ) as never
  );
  const texte = JSON.stringify(await r.json());
  assert.ok(!texte.includes('7788'), 'le code fuit dans la réponse');
  assert.ok(!/[0-9a-f]{64}/.test(texte), 'une empreinte fuit dans la réponse');
});
