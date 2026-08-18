/**
 * Tests des invitations nominatives (magasin + module de jetons).
 * Lance : node --experimental-strip-types --test scripts/invite.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'invite-'));
process.chdir(sandbox);

const store = await import('../src/lib/server/users-store.ts');
const inv = await import('../src/lib/server/invite.ts');
const USERS_FILE = path.join(sandbox, 'data', 'users.json');

const admin = await store.createUser({ email: 'chef@exemple.fr', role: 'admin', status: 'active' });
const membre = await store.createUser({ email: 'ex@exemple.fr', role: 'famille' });

const brut = async (id: string) =>
  JSON.parse(await fs.readFile(USERS_FILE, 'utf-8')).users.find((u: { id: string }) => u.id === id);

async function patch(id: string, champs: Record<string, unknown>) {
  const j = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  j.users = j.users.map((u: { id: string }) => (u.id === id ? { ...u, ...champs } : u));
  await fs.writeFile(USERS_FILE, JSON.stringify(j, null, 2));
  const futur = new Date(Date.now() + 3000);
  await fs.utimes(USERS_FILE, futur, futur);
}

// ─── Module de jetons ──────────────────────────────────────────────────

test('un jeton fait 43 caractères base64url et ne se répète pas', () => {
  const a = inv.createInviteToken();
  const b = inv.createInviteToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(inv.looksLikeInviteToken(a), true);
});

test('looksLikeInviteToken rejette tout ce qui ne peut pas correspondre', () => {
  for (const v of [
    '',
    'court',
    'a'.repeat(42),
    'a'.repeat(44),
    'avec/slash'.padEnd(43, 'x'),
    42,
    null
  ]) {
    assert.equal(inv.looksLikeInviteToken(v), false, `${JSON.stringify(v)} devrait être rejeté`);
  }
});

test('l’empreinte est stable et la comparaison résiste aux formes cassées', () => {
  const t = inv.createInviteToken();
  const h = inv.hashInviteToken(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(inv.hashInviteToken(t), h);
  assert.equal(inv.inviteHashMatches(h, h), true);
  assert.equal(inv.inviteHashMatches(h, inv.hashInviteToken(inv.createInviteToken())), false);
  assert.equal(inv.inviteHashMatches('pas-hexa', h), false);
  assert.equal(inv.inviteHashMatches('', h), false);
});

// ─── Magasin ───────────────────────────────────────────────────────────

test('issueInvite stocke l’EMPREINTE, jamais le jeton', async () => {
  const { token, expiresAt } = await store.issueInvite(membre.id);
  const u = await brut(membre.id);
  assert.match(u.inviteHash, /^[0-9a-f]{64}$/);
  assert.equal(u.inviteHash, inv.hashInviteToken(token));
  assert.ok(!JSON.stringify(u).includes(token), 'le jeton en clair est dans le fichier');
  assert.ok(expiresAt > Date.now());
  assert.equal(u.inviteUsedAt, null);
});

test('le bon jeton retrouve SON utilisateur, et lui seul', async () => {
  const { token } = await store.issueInvite(membre.id);
  const trouve = await store.findUserByInviteToken(token);
  assert.equal(trouve?.id, membre.id);
  assert.equal(await store.findUserByInviteToken(inv.createInviteToken()), null);
});

test('régénérer une invitation invalide la précédente', async () => {
  const { token: ancien } = await store.issueInvite(membre.id);
  const { token: nouveau } = await store.issueInvite(membre.id);
  assert.equal(await store.findUserByInviteToken(ancien), null, 'l’ancien lien marche encore');
  assert.equal((await store.findUserByInviteToken(nouveau))?.id, membre.id);
});

test('invitation périmée → refusée', async () => {
  const { token } = await store.issueInvite(membre.id);
  await patch(membre.id, { inviteExpiresAt: Date.now() - 1000 });
  assert.equal(await store.findUserByInviteToken(token), null);
});

test('durée de vie paramétrable, et défaut à 7 jours', async () => {
  const { expiresAt } = await store.issueInvite(membre.id);
  const jours = (expiresAt - Date.now()) / 86_400_000;
  assert.ok(jours > 6.9 && jours < 7.1, `défaut inattendu : ${jours} j`);
  const court = await store.issueInvite(membre.id, 60_000);
  assert.ok(court.expiresAt - Date.now() <= 60_000);
});

test('compte révoqué : son lien ne fonctionne plus', async () => {
  const { token } = await store.issueInvite(membre.id);
  await patch(membre.id, { status: 'revoked' });
  assert.equal(await store.findUserByInviteToken(token), null);
  await patch(membre.id, { status: 'active' });
  assert.equal((await store.findUserByInviteToken(token))?.id, membre.id, 'réactivé, ça remarche');
});

test('revokeInvite coupe le lien immédiatement', async () => {
  const { token } = await store.issueInvite(membre.id);
  await store.revokeInvite(membre.id);
  assert.equal(await store.findUserByInviteToken(token), null);
  const u = await brut(membre.id);
  assert.equal(u.inviteHash, null);
  assert.equal(u.inviteExpiresAt, null);
});

test('markInviteUsed horodate UNE fois et ne consomme pas le lien', async () => {
  const { token } = await store.issueInvite(membre.id);
  const avantStatut = (await brut(membre.id)).status;

  await store.markInviteUsed(membre.id);
  const apres = await brut(membre.id);
  assert.ok(apres.inviteUsedAt, 'la première entrée doit être horodatée');
  assert.equal(apres.status, avantStatut, 'le statut ne doit plus bouger tout seul');

  // Le lien reste VALIDE (aperçus SMS/WhatsApp) et l'horodatage ne bouge plus.
  const mtimeAvant = (await fs.stat(USERS_FILE)).mtimeMs;
  await store.markInviteUsed(membre.id);
  await store.markInviteUsed(membre.id);
  assert.equal((await brut(membre.id)).inviteUsedAt, apres.inviteUsedAt);
  assert.equal((await fs.stat(USERS_FILE)).mtimeMs, mtimeAvant, 'réécritures inutiles');
  assert.equal((await store.findUserByInviteToken(token))?.id, membre.id, 'le lien a été consommé');
});

test('id inconnu : issueInvite jette, revokeInvite et markInviteUsed non', async () => {
  await assert.rejects(() => store.issueInvite('fantome'));
  await store.revokeInvite('fantome');
  await store.markInviteUsed('fantome');
});

test('les invitations sont bien PAR personne', async () => {
  const a = await store.issueInvite(admin.id);
  const b = await store.issueInvite(membre.id);
  assert.equal((await store.findUserByInviteToken(a.token))?.id, admin.id);
  assert.equal((await store.findUserByInviteToken(b.token))?.id, membre.id);
});

// ─── Compatibilité ascendante du fichier ───────────────────────────────

test('un users.json écrit AVANT la phase 3 se relit sans perdre personne', async () => {
  const j = JSON.parse(await fs.readFile(USERS_FILE, 'utf-8'));
  for (const u of j.users) {
    delete u.inviteHash;
    delete u.inviteExpiresAt;
    delete u.inviteUsedAt;
  }
  await fs.writeFile(USERS_FILE, JSON.stringify(j, null, 2));
  const futur = new Date(Date.now() + 5000);
  await fs.utimes(USERS_FILE, futur, futur);

  const users = await store.readUsers();
  assert.equal(users.length, 2, 'des comptes ont été écartés à la relecture');
  for (const u of users) {
    assert.equal(u.inviteHash, null);
    assert.equal(u.inviteExpiresAt, null);
    assert.equal(u.inviteUsedAt, null);
  }
});
