/**
 * Tests de la table des droits — source UNIQUE de « qui a le droit de quoi ».
 * Lance : node --experimental-strip-types --test scripts/access.test.ts
 *
 * Le dernier test est le plus important : il énumère TOUTES les routes d'API qui
 * écrivent, et exige que chacune soit soit réservée, soit inscrite dans la liste
 * des ouvertes assumées. Une route neuve fait donc échouer la suite tant que
 * personne n'a tranché — c'est ce qui remplace les contrôles recopiés dans
 * chaque fichier, sans revenir à trois définitions de la même règle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RESERVE_ADMIN, reservePour } from '../src/lib/server/access.ts';

// ─── Comportement de la table ──────────────────────────────────────────

test('lire reste ouvert, écrire est réservé', () => {
  assert.equal(reservePour('GET', '/api/cumulus/config'), null, 'la lecture doit rester ouverte');
  assert.ok(reservePour('PUT', '/api/cumulus/config'), 'l’écriture doit être réservée');
});

test('les commandes des boucles sont réservées, leur lecture non', () => {
  assert.ok(reservePour('POST', '/api/sb3loop/command'));
  assert.ok(reservePour('POST', '/api/apsloop/command'));
  assert.equal(reservePour('GET', '/api/sb3loop/status'), null);
  // Les ticks systemd sortent AVANT la garde (Bearer) — ils ne sont pas dans la table.
  assert.equal(reservePour('POST', '/api/sb3loop/tick'), null);
});

test('supprimer un morceau est réservé, quel que soit l’identifiant', () => {
  assert.ok(reservePour('DELETE', '/api/plex/item/12345'));
  assert.ok(reservePour('DELETE', '/api/plex/item/abc-def'));
  assert.equal(reservePour('GET', '/api/plex/item/12345'), null);
  // Les listes de lecture ne touchent pas aux fichiers : elles restent ouvertes.
  assert.equal(reservePour('DELETE', '/api/plex/playlists/42'), null);
});

test('la gestion des accès est réservée pour toutes les méthodes', () => {
  for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) {
    assert.ok(reservePour(m, '/api/users'), `${m} /api/users`);
    assert.ok(reservePour(m, '/api/users/invite'), `${m} /api/users/invite`);
  }
});

test('la page /menu/acces n’est PAS réservée : elle s’adapte', () => {
  assert.equal(reservePour('GET', '/menu/acces'), null);
});

test('un chemin voisin n’est pas attrapé par erreur', () => {
  assert.equal(
    reservePour('POST', '/api/cumulus/command'),
    null,
    'la commande n’est pas la config'
  );
  assert.equal(reservePour('POST', '/api/cumulus/config-bis'), null);
  assert.equal(reservePour('GET', '/api/usersautre'), null);
});

test('chaque réserve porte un libellé en français, affichable tel quel', () => {
  for (const r of RESERVE_ADMIN) {
    assert.ok(r.libelle.length > 8, `libellé trop court : ${r.libelle}`);
    assert.match(r.libelle, /^[A-ZÀ-Ý]/, `le libellé doit ouvrir la phrase : ${r.libelle}`);
  }
});

// ─── Couverture : aucune route d'écriture ne passe entre les mailles ───

/**
 * Routes d'écriture DÉLIBÉRÉMENT ouvertes à tout le foyer. Toute route absente
 * d'ici ET de la table fait échouer le test — pour qu'ajouter un endpoint force
 * une décision au lieu de l'oublier.
 */
const OUVERTES_ASSUMEES = new Set([
  '/api/airzone/command', // clim : usage quotidien
  '/api/apsloop/tick', // timer systemd, Bearer
  '/api/auth/logout',
  '/api/auth/pin-login', // publique, protégée par verrou + limite d'appelant
  '/api/account/pin', // chacun son code ; viser autrui est jugé dans la route
  '/api/cumulus/command', // allumer/couper le ballon : usage quotidien
  '/api/cumulus/relay',
  '/api/cumulus/tick',
  '/api/daikin/units/[unitId]/command',
  '/api/monitor/tick',
  '/api/planning',
  '/api/plex/link',
  '/api/plex/playlists',
  '/api/plex/playlists/[key]',
  '/api/plex/playlists/[key]/items',
  '/api/plex/playlists/[key]/items/[itemId]',
  '/api/plex/scan',
  '/api/plex/smart',
  '/api/plex/upload',
  '/api/portail/pulse', // Bearer OU cookie + en-tête applicatif
  '/api/push/subscribe',
  '/api/sb3loop/tick',
  '/api/settings',
  '/api/tariffs/regime',
  '/api/temperature/tick',
  '/api/thermostat/command',
  '/api/wled/[...path]',
  '/api/wled/music/beat',
  '/api/wled/music/mode',
  '/api/zigbee/set'
]);

/** Chemin d'URL d'un fichier de route (les segments dynamiques sont conservés). */
function urlDe(fichier: string): string {
  return '/' + path.dirname(fichier).replace(/\\/g, '/');
}

async function routesQuiEcrivent(): Promise<string[]> {
  const racine = path.resolve(import.meta.dirname, '..', 'src', 'routes', 'api');
  const trouvees: string[] = [];
  async function parcours(dir: string, url: string) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await parcours(p, `${url}/${e.name}`);
      else if (e.name === '+server.ts') {
        const src = await fs.readFile(p, 'utf-8');
        if (/export const (POST|PUT|PATCH|DELETE)/.test(src)) trouvees.push(url);
      }
    }
  }
  await parcours(racine, '/api');
  return trouvees.sort();
}

test('toute route d’écriture est soit réservée, soit ouverte ASSUMÉE', async () => {
  const oubliees: string[] = [];
  for (const url of await routesQuiEcrivent()) {
    // On sonde avec un chemin concret : les segments dynamiques sont remplacés.
    const concret = url.replace(/\[\.\.\.[^\]]+\]/g, 'x').replace(/\[[^\]]+\]/g, 'x');
    const reservee = ['POST', 'PUT', 'PATCH', 'DELETE'].some((m) => reservePour(m, concret));
    if (!reservee && !OUVERTES_ASSUMEES.has(url)) oubliees.push(url);
  }
  assert.deepEqual(
    oubliees,
    [],
    `Route(s) d'écriture sans décision : ajoute-les à RESERVE_ADMIN (access.ts) ou à OUVERTES_ASSUMEES (ce test).`
  );
});

test('la liste des ouvertes assumées ne contient pas de route disparue', async () => {
  const existantes = new Set(await routesQuiEcrivent());
  const fantomes = [...OUVERTES_ASSUMEES].filter((u) => !existantes.has(u));
  assert.deepEqual(fantomes, [], 'entrées à retirer de OUVERTES_ASSUMEES');
});
