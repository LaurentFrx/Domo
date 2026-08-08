/**
 * Tests du module de PIN (hachage, vérification, format).
 * Lance : node --experimental-strip-types --test scripts/pin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, isValidPinFormat, dummyVerify } from '../src/lib/server/pin.ts';

test('format : exactement 4 chiffres', () => {
  for (const bon of ['0000', '1234', '9999']) {
    assert.equal(isValidPinFormat(bon), true, `${bon} devrait être accepté`);
  }
  for (const mauvais of [
    '123',
    '12345',
    '12a4',
    '',
    ' 1234',
    '1234 ',
    '12 4',
    '-123',
    '１２３４'
  ]) {
    assert.equal(
      isValidPinFormat(mauvais),
      false,
      `${JSON.stringify(mauvais)} devrait être refusé`
    );
  }
});

test('format : type non-chaîne refusé sans jeter', () => {
  for (const v of [undefined, null, 1234, {}, []]) {
    assert.equal(isValidPinFormat(v), false);
  }
});

test('aller-retour : le bon code se vérifie', () => {
  const { hash, salt } = hashPin('4271');
  assert.equal(verifyPin('4271', salt, hash), true);
});

test('un autre code ne se vérifie pas', () => {
  const { hash, salt } = hashPin('4271');
  for (const faux of ['4270', '1724', '0000', '9999']) {
    assert.equal(verifyPin(faux, salt, hash), false);
  }
});

test('deux codes IDENTIQUES donnent des empreintes différentes (sel par personne)', () => {
  const a = hashPin('1111');
  const b = hashPin('1111');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  // ... et chacune se vérifie avec SON sel, pas celui de l'autre.
  assert.equal(verifyPin('1111', a.salt, a.hash), true);
  assert.equal(verifyPin('1111', b.salt, a.hash), false);
});

test('empreinte : 32 octets, sel 16 octets, en hexadécimal', () => {
  const { hash, salt } = hashPin('5555');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.match(salt, /^[0-9a-f]{32}$/);
});

test('entrées corrompues → false, jamais de jet', () => {
  const { hash, salt } = hashPin('1234');
  assert.equal(verifyPin('1234', 'pas-de-l-hexa', hash), false);
  assert.equal(verifyPin('1234', salt, 'trop-court'), false);
  assert.equal(verifyPin('1234', salt, ''), false);
  assert.equal(verifyPin('1234', salt, hash.slice(0, 60)), false);
});

test('dummyVerify ne jette pas et coûte un temps comparable à une vérification', () => {
  const { hash, salt } = hashPin('1234');
  const t0 = process.hrtime.bigint();
  verifyPin('9999', salt, hash);
  const reel = Number(process.hrtime.bigint() - t0);
  const t1 = process.hrtime.bigint();
  dummyVerify();
  const factice = Number(process.hrtime.bigint() - t1);
  // Même ordre de grandeur : c'est tout ce qui compte pour masquer l'existence
  // d'un compte. On reste très large pour ne pas rendre le test instable.
  assert.ok(
    factice > reel / 10 && factice < reel * 10,
    `écart trop grand : réel=${reel}ns factice=${factice}ns`
  );
});
