/**
 * Tests de l'accès de démonstration.
 * Lance : node --experimental-strip-types --test scripts/demo.test.ts
 *
 * Deux propriétés comptent plus que les autres :
 *   1. une démo ne peut RIEN commander ;
 *   2. en maison simulée, un endpoint oublié devient MUET, jamais bavard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authParJeton, refusPour } from '../src/lib/server/access.ts';
import { PROJECTIONS, projeter } from '../src/lib/server/demo/projections.ts';
import { etatMaison } from '../src/lib/server/demo/maison.ts';

// ─── Lecture seule ─────────────────────────────────────────────────────

test('une démo ne peut commander AUCUN appareil', () => {
  const commandes = [
    '/api/cumulus/command',
    '/api/cumulus/relay',
    '/api/airzone/command',
    '/api/daikin/units/x/command',
    '/api/thermostat/command',
    '/api/zigbee/set',
    '/api/portail/pulse',
    '/api/wled/music/mode',
    '/api/settings',
    '/api/planning',
    '/api/account/pin'
  ];
  for (const c of commandes) {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.ok(refusPour('demo', m, c), `${m} ${c} devrait être refusé en démo`);
    }
  }
});

test('… alors que la famille, elle, commande tout ça normalement', () => {
  for (const c of ['/api/cumulus/command', '/api/airzone/command', '/api/zigbee/set']) {
    assert.equal(refusPour('famille', 'POST', c), null, c);
  }
});

test('une démo peut LIRE, et peut partir', () => {
  for (const c of ['/api/anker/status', '/api/airzone/status', '/api/savings']) {
    assert.equal(refusPour('demo', 'GET', c), null, c);
  }
  assert.equal(
    refusPour('demo', 'POST', '/api/auth/logout'),
    null,
    'se déconnecter reste possible'
  );
});

test('la localisation des téléphones est interdite en démo, même en lecture', () => {
  assert.ok(refusPour('demo', 'GET', '/api/findmy/stream'));
  // …mais reste accessible à la famille.
  assert.equal(refusPour('famille', 'GET', '/api/findmy/stream'), null);
});

test('une démo n’hérite évidemment pas des opérations réservées', () => {
  assert.ok(refusPour('demo', 'POST', '/api/sb3loop/command'));
  assert.ok(refusPour('demo', 'GET', '/api/users'));
});

// ─── Maison simulée ────────────────────────────────────────────────────

test('un endpoint NON simulé ne renvoie rien du réel', () => {
  assert.equal(projeter('/api/plex/browse'), null);
  assert.equal(projeter('/api/zigbee/stream'), null);
  assert.equal(projeter('/api/printer/status'), null);
});

test('les endpoints du cœur de la démo sont bien simulés', () => {
  for (const c of [
    '/api/anker/status',
    '/api/apsystems/status',
    '/api/em50/status',
    '/api/cumulus/orchestrator',
    '/api/airzone/status',
    '/api/daikin/status',
    '/api/thermostat/status',
    '/api/forecast',
    '/api/savings',
    '/api/tariffs/current'
  ]) {
    assert.ok(projeter(c), `${c} devrait être simulé`);
  }
});

test('les projections respectent le contrat réel des routes', () => {
  const anker = projeter('/api/anker/status') as Record<string, unknown>;
  for (const k of [
    'connected',
    'solar_power_w',
    'grid_power_w',
    'batteries',
    'smart_meter',
    'sites'
  ]) {
    assert.ok(k in anker, `champ manquant : ${k}`);
  }
  assert.equal((anker.batteries as unknown[]).length, 3, 'Max AC + 2 Solarbank');

  const aps = projeter('/api/apsystems/status') as Record<string, number>;
  assert.ok(aps.power_w <= aps.max_power_w, 'l’onduleur dépasse son plafond');

  const zones = (projeter('/api/airzone/status') as { zones: { name: string }[] }).zones;
  assert.deepEqual(
    zones.map((z) => z.name),
    ['Parents', 'Amis', 'Bureau'],
    'les zones doivent être celles de l’installation'
  );
});

test('la maison simulée reste physiquement cohérente', () => {
  for (let h = 0; h < 24; h += 3) {
    const e = etatMaison(Date.UTC(2026, 7, 17, 22, 0, 0) + h * 3_600_000);
    const bilan =
      e.pvW + e.batterieDechargeW - e.maisonW - e.ballonW - e.batterieChargeW + e.reseauW;
    assert.equal(bilan, 0, `bilan non nul à ${h} h : ${bilan} W`);
    assert.ok(e.batterieSoc >= 0 && e.batterieSoc <= 100, `SoC hors bornes : ${e.batterieSoc}`);
    assert.ok(e.ballonC > 20 && e.ballonC <= 60, `ballon hors bornes : ${e.ballonC}`);
  }
});

test('elle évolue : deux heures différentes ne donnent pas le même état', () => {
  const a = etatMaison(Date.UTC(2026, 7, 18, 9, 0, 0));
  const b = etatMaison(Date.UTC(2026, 7, 18, 15, 0, 0));
  assert.notEqual(a.pvW, b.pvW);
  assert.notEqual(a.batterieSoc, b.batterieSoc);
});

test('… mais reste déterministe : même instant, même maison', () => {
  const t = Date.UTC(2026, 7, 18, 12, 30, 0);
  assert.deepEqual(etatMaison(t), etatMaison(t));
});

test('aucune projection ne laisse échapper une adresse ou une position', () => {
  const tout = JSON.stringify(Object.keys(PROJECTIONS).map((c) => projeter(c)));
  assert.ok(!/feroux|orange\.fr|isaproisy|laurent/i.test(tout), 'une donnée personnelle apparaît');
  assert.ok(!/"lat"|"lon"|latitude|longitude/.test(tout), 'une coordonnée apparaît');
});

// ─── Le portail, régression du 2026-08-18 ──────────────────────────────

test('la dérogation à jeton EXIGE l’en-tête Authorization', () => {
  // Sans cette condition, un appel par cookie sur ces chemins échappait à la
  // garde des droits — et le bouton Portail de /pieces envoie précisément un
  // cookie. Un visiteur de démonstration ouvrait le portail.
  for (const c of ['/api/portail/pulse', '/api/cumulus/tick', '/api/sb3loop/tick']) {
    assert.equal(authParJeton(c, false), false, `${c} ne doit pas déroger sans jeton`);
    assert.equal(authParJeton(c, true), true, `${c} doit déroger avec jeton`);
  }
});

test('un chemin voisin ne déroge jamais, même avec un jeton', () => {
  assert.equal(authParJeton('/api/portail/pulse/x', true), false);
  assert.equal(authParJeton('/api/cumulus/command', true), false);
});

test('sans la dérogation, la démo est bien refusée sur le portail', () => {
  assert.ok(refusPour('demo', 'POST', '/api/portail/pulse'));
  assert.equal(refusPour('famille', 'POST', '/api/portail/pulse'), null);
});
