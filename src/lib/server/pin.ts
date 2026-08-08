/**
 * PIN de secours — hachage et vérification. Server-only.
 *
 * Un code à 4 chiffres, c'est 10 000 combinaisons : le hachage seul ne protège
 * de rien si l'on peut essayer vite. La vraie défense est le VERROU par compte
 * (3 essais puis 15 min, cf. `attemptPinLogin` dans users-store). scrypt s'y
 * ajoute pour que le vol du fichier `users.json` ne livre pas les codes en
 * clair, et que chaque essai coûte un temps non négligeable.
 *
 * Paramètres : scrypt par défaut de Node (N=16384, r=8, p=1), keylen 32,
 * sel aléatoire de 16 octets, distinct par utilisateur (deux personnes avec le
 * même code n'ont pas la même empreinte).
 */
import crypto from 'node:crypto';

const KEYLEN = 32;
const SALT_BYTES = 16;

/** Exactement 4 chiffres — ni espace, ni signe, ni code plus long. */
export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(SALT_BYTES);
  return {
    hash: crypto.scryptSync(pin, salt, KEYLEN).toString('hex'),
    salt: salt.toString('hex')
  };
}

/** Comparaison à temps constant (même patron que `checkMagicToken`). */
export function verifyPin(pin: string, salt: string, hash: string): boolean {
  try {
    const expected = Buffer.from(hash, 'hex');
    if (expected.length !== KEYLEN) return false;
    const actual = crypto.scryptSync(pin, Buffer.from(salt, 'hex'), KEYLEN);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Dérivation À VIDE, au coût identique à une vraie vérification.
 *
 * Sans elle, un email inconnu répondrait en ~0 ms là où un email connu coûte le
 * temps d'un scrypt : le simple chronométrage dirait à un attaquant quelles
 * adresses existent dans le magasin, alors même que le message d'erreur reste
 * volontairement générique. On paie donc le même prix dans tous les cas.
 */
export function dummyVerify(): void {
  try {
    crypto.scryptSync('0000', crypto.randomBytes(SALT_BYTES), KEYLEN);
  } catch {
    /* jamais bloquant */
  }
}
