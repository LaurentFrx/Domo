/**
 * Tests du limiteur de débit partagé.
 * Lance : node --experimental-strip-types --test scripts/rate-limit.test.ts
 *
 * Un test porte spécifiquement le seuil HISTORIQUE de /api/portail/pulse
 * (6 par minute) : c'est lui qui atteste que l'extraction du code hors de la
 * route n'a pas déplacé la frontière.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, clientKey } from '../src/lib/server/rate-limit.ts';

test('portail/pulse : 6 appels tolérés, le 7e est limité (comportement d’origine)', () => {
  const l = createRateLimiter({ windowMs: 60_000, max: 6 });
  for (let i = 1; i <= 6; i++) {
    assert.equal(l.hit('ip').limited, false, `appel ${i} devrait passer`);
  }
  assert.equal(l.hit('ip').limited, true, 'le 7e devrait être limité');
});

test('les seaux sont indépendants par clé', () => {
  const l = createRateLimiter({ windowMs: 60_000, max: 2 });
  l.hit('a');
  l.hit('a');
  assert.equal(l.hit('a').limited, true);
  assert.equal(l.hit('b').limited, false, 'une autre clé ne doit pas hériter du blocage');
});

test('deux limiteurs ne partagent RIEN (une route n’épuise pas l’autre)', () => {
  const a = createRateLimiter({ windowMs: 60_000, max: 1 });
  const b = createRateLimiter({ windowMs: 60_000, max: 1 });
  a.hit('ip');
  assert.equal(a.hit('ip').limited, true);
  assert.equal(b.hit('ip').limited, false);
});

test('retryAfterMs est cohérent avec la fenêtre', () => {
  const l = createRateLimiter({ windowMs: 60_000, max: 1 });
  l.hit('ip');
  const v = l.hit('ip');
  assert.equal(v.limited, true);
  assert.ok(v.retryAfterMs > 0 && v.retryAfterMs <= 60_000, `incohérent : ${v.retryAfterMs}`);
});

test('la fenêtre glisse : les coups anciens sortent du compte', async () => {
  const l = createRateLimiter({ windowMs: 60, max: 2 });
  l.hit('ip');
  l.hit('ip');
  assert.equal(l.hit('ip').limited, true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(l.hit('ip').limited, false, 'après la fenêtre, le seau doit être vide');
});

test('un appel refusé est tout de même compté (marteler ne raccourcit rien)', () => {
  const l = createRateLimiter({ windowMs: 60_000, max: 1 });
  l.hit('ip');
  const premier = l.hit('ip').retryAfterMs;
  for (let i = 0; i < 5; i++) l.hit('ip');
  assert.equal(l.hit('ip').limited, true, 'toujours bloqué après avoir insisté');
  assert.ok(premier > 0);
});

// ─── Identification de l'appelant derrière Caddy ───────────────────────

const faux = (socket: string, xff?: string) => ({
  getClientAddress: () => socket,
  request: new Request('http://localhost/x', { headers: xff ? { 'x-forwarded-for': xff } : {} })
});

test('socket loopback + XFF → dernière entrée de XFF', () => {
  assert.equal(clientKey(faux('127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(clientKey(faux('::1', '198.51.100.7')), '198.51.100.7');
  assert.equal(clientKey(faux('::ffff:127.0.0.1', '198.51.100.7')), '198.51.100.7');
});

test('XFF précédé de valeurs forgées : seule la dernière est retenue', () => {
  assert.equal(clientKey(faux('127.0.0.1', '10.0.0.1, 8.8.8.8, 198.51.100.7')), '198.51.100.7');
});

test('socket NON loopback : XFF ignoré (un appelant direct ne forge pas sa clé)', () => {
  assert.equal(clientKey(faux('203.0.113.9', '198.51.100.7')), '203.0.113.9');
});

test('loopback sans XFF → l’adresse de socket, comme avant', () => {
  assert.equal(clientKey(faux('127.0.0.1')), '127.0.0.1');
});

test('getClientAddress qui jette → clé de repli, sans planter', () => {
  const cassé = {
    getClientAddress: () => {
      throw new Error('indisponible');
    },
    request: new Request('http://localhost/x')
  };
  assert.equal(clientKey(cassé), 'inconnue');
});
