/**
 * Magasin des utilisateurs autorisés — fichier JSON local.
 *
 * Stockage : `data/users.json` à la racine du projet (gitignored, comme
 * settings.json). Même socle de durabilité que les réglages : `atomic-store`
 * (écriture fsync + .bak, lecture auto-réparante sur corruption + incident).
 *
 * Phase 1 : ce module ne fait QUE porter l'identité. Les champs de PIN existent
 * dans le schéma mais restent à `null` — le mécanisme de secours viendra dans
 * une phase séparée, et le schéma est posé maintenant pour ne pas avoir à
 * migrer le fichier plus tard.
 *
 * CACHE : `hooks.server.ts` résout l'utilisateur à CHAQUE requête authentifiée
 * (y compris les polls Anker 15 s / APsystems 10 s). Relire et reparser le
 * fichier à chaque fois serait un impôt inutile sur le chemin chaud. On garde
 * donc le contenu en mémoire, invalidé par le `mtime` du fichier : un `stat`
 * (quelques µs) au lieu d'un read+JSON.parse. Le mtime — et non un TTL — parce
 * qu'il rend l'édition MANUELLE de `data/users.json` immédiatement effective :
 * tant que la page d'administration n'existe pas, c'est la seule façon de
 * révoquer quelqu'un, et elle doit prendre effet tout de suite.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
// Extension explicite : ce module est chargé tel quel par `node --test`
// (cf. scripts/users-store.test.ts), qui n'a pas le résolveur de Vite.
import { readJsonSafe, writeJsonAtomic, withFileLock } from './atomic-store.ts';
import { dummyVerify, hashPin, verifyPin } from './pin.ts';
import {
  INVITE_TTL_MS,
  createInviteToken,
  hashInviteToken,
  inviteHashMatches,
  looksLikeInviteToken
} from './invite.ts';

const USERS_FILE = path.resolve(process.cwd(), 'data', 'users.json');

export type UserRole = 'admin' | 'famille';
/**
 * Deux états, pas trois. « Invité » (créé, jamais venu) doublonnait avec
 * `lastLoginAt === null` : deux sources pour le même fait, et un piège réel —
 * la porte d'entrée exige `active`, si bien qu'un compte resté `invited` parce
 * que l'écriture de bascule avait échoué recevait son cookie puis se faisait
 * renvoyer dehors à la requête suivante, en boucle et sans explication.
 * « Jamais venu » est désormais un simple AFFICHAGE, déduit de lastLoginAt.
 */
export type UserStatus = 'active' | 'revoked';

export interface User {
  /** UUID v4 — stable, porté par le cookie de session. Jamais réutilisé. */
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  /** Réservés à la phase « PIN de secours » — `null` tant qu'aucun PIN n'est posé. */
  pinHash: string | null;
  pinSalt: string | null;
  pinAttempts: number;
  /** Epoch ms de fin de verrouillage après trop d'essais, sinon `null`. */
  pinLockedUntil: number | null;
  /** Invitation nominative en cours — SHA-256 du jeton, jamais le jeton. */
  inviteHash: string | null;
  /** Epoch ms de péremption du lien d'invitation, sinon `null`. */
  inviteExpiresAt: number | null;
  /** ISO 8601 de la PREMIÈRE entrée par ce lien — informatif, ne le consomme pas. */
  inviteUsedAt: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, ou `null` si l'utilisateur ne s'est jamais connecté. */
  lastLoginAt: string | null;
}

/** Enveloppe versionnée : permet une migration de schéma sans deviner le format. */
interface UsersFile {
  version: 1;
  users: User[];
}

const ROLES: readonly UserRole[] = ['admin', 'famille'];
const STATUSES: readonly UserStatus[] = ['active', 'revoked'];

const emptyFile = (): UsersFile => ({ version: 1, users: [] });

/**
 * Normalisation DÉFENSIVE : une entrée malformée est écartée, elle ne fait pas
 * tomber le fichier entier. Un magasin qui refuse de se charger, c'est toute la
 * famille dehors — on préfère perdre une ligne douteuse et crier dans les logs.
 */
function normalize(raw: unknown): UsersFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyFile();
  const list = (raw as { users?: unknown }).users;
  if (!Array.isArray(list)) return emptyFile();

  const users: User[] = [];
  for (const entry of list) {
    const u = entry as Partial<User>;
    if (typeof u?.id !== 'string' || !u.id) continue;
    if (typeof u.email !== 'string' || !u.email) continue;
    if (!ROLES.includes(u.role as UserRole)) continue;
    // Migration silencieuse : les fichiers écrits avant la simplification
    // portent encore « invited ». On le relit comme « active » — c'est
    // l'invitation elle-même, et non le statut, qui garde la porte.
    const statut: UserStatus =
      (u.status as string) === 'invited' ? 'active' : (u.status as UserStatus);
    if (!STATUSES.includes(statut)) continue;
    users.push({
      id: u.id,
      email: u.email,
      role: u.role as UserRole,
      status: statut,
      pinHash: typeof u.pinHash === 'string' ? u.pinHash : null,
      pinSalt: typeof u.pinSalt === 'string' ? u.pinSalt : null,
      pinAttempts: typeof u.pinAttempts === 'number' ? u.pinAttempts : 0,
      pinLockedUntil: typeof u.pinLockedUntil === 'number' ? u.pinLockedUntil : null,
      // Champs d'invitation absents des fichiers écrits avant la phase 3 : on
      // les comble par `null` au lieu d'écarter l'entrée. Migration silencieuse,
      // sans étape manuelle — un users.json de phase 1 se relit tel quel.
      inviteHash: typeof u.inviteHash === 'string' ? u.inviteHash : null,
      inviteExpiresAt: typeof u.inviteExpiresAt === 'number' ? u.inviteExpiresAt : null,
      inviteUsedAt: typeof u.inviteUsedAt === 'string' ? u.inviteUsedAt : null,
      createdAt: typeof u.createdAt === 'string' ? u.createdAt : new Date().toISOString(),
      lastLoginAt: typeof u.lastLoginAt === 'string' ? u.lastLoginAt : null
    });
  }
  if (users.length !== list.length) {
    console.error(`[users-store] ${list.length - users.length} entrée(s) malformée(s) ignorée(s)`);
  }
  return { version: 1, users };
}

// ─── Cache invalidé par mtime ──────────────────────────────────────────

let cache: UsersFile | null = null;
let cacheMtimeMs = -1;

/** Invalide le cache — appelé après toute écriture par ce process. */
function invalidate(): void {
  cache = null;
  cacheMtimeMs = -1;
}

async function load(): Promise<UsersFile> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(USERS_FILE)).mtimeMs;
  } catch {
    // Fichier absent (installation neuve) : `readJsonSafe` renverra le défaut.
    // On ne met PAS ce cas en cache, pour que la création du fichier soit vue.
    return readJsonSafe(USERS_FILE, { fallback: emptyFile, normalize, label: 'users.json' });
  }
  if (cache && mtimeMs === cacheMtimeMs) return cache;

  const value = await readJsonSafe(USERS_FILE, {
    fallback: emptyFile,
    normalize,
    label: 'users.json'
  });
  cache = value;
  cacheMtimeMs = mtimeMs;
  return value;
}

// ─── Lecture ───────────────────────────────────────────────────────────

export async function readUsers(): Promise<User[]> {
  return (await load()).users;
}

export async function findUserById(id: string): Promise<User | null> {
  if (!id) return null;
  return (await readUsers()).find((u) => u.id === id) ?? null;
}

/** Recherche par email, insensible à la casse (les clients mail ne la respectent pas). */
export async function findUserByEmail(email: string): Promise<User | null> {
  const needle = email.trim().toLowerCase();
  if (!needle) return null;
  return (await readUsers()).find((u) => u.email.toLowerCase() === needle) ?? null;
}

/**
 * Premier administrateur ACTIF, ou `null`. Sert au flux `/auth?k=…` : le lien
 * magique global n'identifie personne, on le rattache donc au propriétaire.
 */
export async function findActiveAdmin(): Promise<User | null> {
  return (await readUsers()).find((u) => u.role === 'admin' && u.status === 'active') ?? null;
}

// ─── Écriture ──────────────────────────────────────────────────────────

/** Écrit la liste complète (sérialisé par fichier — pas de lost update). */
async function commit(users: User[]): Promise<void> {
  await writeJsonAtomic(USERS_FILE, { version: 1, users } satisfies UsersFile);
  invalidate();
}

export interface NewUser {
  email: string;
  role: UserRole;
  status?: UserStatus;
}

/**
 * Crée un utilisateur. Rejette un doublon d'email (la clé fonctionnelle réelle,
 * même si l'`id` est la clé technique). Aucun PIN n'est posé ici.
 */
export async function createUser(input: NewUser): Promise<User> {
  const email = input.email.trim();
  if (!email) throw new Error('users: email requis');
  return withFileLock(USERS_FILE, async () => {
    const users = [...(await readUsers())];
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      throw new Error(`users: ${email} existe déjà`);
    }
    const user: User = {
      id: crypto.randomUUID(),
      email,
      role: input.role,
      status: input.status ?? 'active',
      pinHash: null,
      pinSalt: null,
      pinAttempts: 0,
      pinLockedUntil: null,
      inviteHash: null,
      inviteExpiresAt: null,
      inviteUsedAt: null,
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };
    users.push(user);
    await commit(users);
    return user;
  });
}

// ─── PIN de secours ────────────────────────────────────────────────────

/** Essais consécutifs autorisés avant verrouillage. */
export const PIN_MAX_ATTEMPTS = 3;
/** Durée du verrouillage, en millisecondes. */
export const PIN_LOCK_MS = 15 * 60 * 1000;

/** Pose (ou remplace) le PIN d'un utilisateur et remet les compteurs à zéro —
 *  un code neuf ne doit pas hériter du verrou de l'ancien. */
export async function setUserPin(userId: string, pin: string): Promise<void> {
  const { hash, salt } = hashPin(pin);
  return withFileLock(USERS_FILE, async () => {
    const users = [...(await readUsers())];
    const i = users.findIndex((u) => u.id === userId);
    if (i === -1) throw new Error('users: utilisateur introuvable');
    users[i] = {
      ...users[i],
      pinHash: hash,
      pinSalt: salt,
      pinAttempts: 0,
      pinLockedUntil: null
    };
    await commit(users);
  });
}

export type PinLoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'locked'; retryAfterMs: number }
  | { ok: false; reason: 'not_found' | 'no_pin' | 'wrong_pin' };

/**
 * Tentative de connexion par email + PIN.
 *
 * TOUT le cycle lecture → décision → écriture est pris dans `withFileLock` :
 * sans ça, trois essais simultanés liraient le même `pinAttempts` et
 * l'incrémenteraient chacun à 1 — le verrou ne se déclencherait jamais, ce qui
 * viderait la protection de sa substance.
 *
 * Le motif retourné est DÉTAILLÉ pour les tests et les logs ; c'est à la route
 * de l'aplatir en un message unique côté client (cf. /api/auth/pin-login).
 */
export async function attemptPinLogin(email: string, pin: string): Promise<PinLoginResult> {
  return withFileLock(USERS_FILE, async () => {
    const users = [...(await readUsers())];
    const needle = email.trim().toLowerCase();
    const i = users.findIndex((u) => u.email.toLowerCase() === needle);

    // Compte inconnu ou désactivé. `dummyVerify` égalise le temps de réponse
    // avec celui d'un compte réel — cf. pin.ts.
    if (i === -1 || users[i].status !== 'active') {
      dummyVerify();
      return { ok: false, reason: 'not_found' };
    }

    const u = users[i];
    if (!u.pinHash || !u.pinSalt) {
      dummyVerify();
      return { ok: false, reason: 'no_pin' };
    }

    const now = Date.now();
    if (u.pinLockedUntil !== null && u.pinLockedUntil > now) {
      // On ne vérifie PAS le code pendant le verrouillage : un essai ne doit ni
      // consommer d'essai, ni repousser l'échéance.
      return { ok: false, reason: 'locked', retryAfterMs: u.pinLockedUntil - now };
    }

    // Verrou expiré → la fenêtre repart à neuf. Sans cette remise à zéro,
    // `pinAttempts` resterait à 3 et le premier faux essai suivant reverrouillerait
    // aussitôt : « déverrouillé » ne voudrait plus rien dire.
    const attemptsBefore = u.pinLockedUntil !== null ? 0 : u.pinAttempts;

    if (verifyPin(pin, u.pinSalt, u.pinHash)) {
      users[i] = {
        ...u,
        pinAttempts: 0,
        pinLockedUntil: null,
        lastLoginAt: new Date().toISOString()
      };
      await commit(users);
      return { ok: true, userId: u.id };
    }

    const attempts = attemptsBefore + 1;
    users[i] = {
      ...u,
      pinAttempts: attempts,
      pinLockedUntil: attempts >= PIN_MAX_ATTEMPTS ? now + PIN_LOCK_MS : null
    };
    await commit(users);
    return { ok: false, reason: 'wrong_pin' };
  });
}

// ─── Modification et suppression ───────────────────────────────────────

export interface UserPatch {
  role?: UserRole;
  status?: UserStatus;
}

/** Levée si l'opération laisserait le foyer sans personne pour administrer. */
export class DernierAdminError extends Error {
  constructor() {
    super('users: il doit rester au moins un administrateur actif');
    this.name = 'DernierAdminError';
  }
}

/**
 * Garde-fou d'enfermement : après toute modification, au moins un compte doit
 * rester `admin` ET `active`.
 *
 * Sans lui, se rétrograder soi-même en « famille » ou se révoquer par mégarde
 * rendrait l'administration définitivement inatteignable depuis l'interface —
 * il faudrait rouvrir `users.json` à la main sur le VPS. La trappe AUTH_TOKEN
 * dépanne, mais elle s'appuie justement sur `findActiveAdmin()` : plus d'admin
 * actif, et elle retombe sur un cookie anonyme sans pouvoir.
 */
function resteUnAdmin(users: User[]): boolean {
  return users.some((u) => u.role === 'admin' && u.status === 'active');
}

export async function updateUser(id: string, patch: UserPatch): Promise<User> {
  return withFileLock(USERS_FILE, async () => {
    const users = [...(await readUsers())];
    const i = users.findIndex((u) => u.id === id);
    if (i === -1) throw new Error('users: utilisateur introuvable');

    const modifie: User = {
      ...users[i],
      role: patch.role ?? users[i].role,
      status: patch.status ?? users[i].status
    };
    // Révoquer quelqu'un coupe aussi son lien : le laisser vivant permettrait
    // de rentrer à nouveau dès la réactivation, sans décision explicite.
    if (modifie.status === 'revoked') {
      modifie.inviteHash = null;
      modifie.inviteExpiresAt = null;
    }
    users[i] = modifie;

    if (!resteUnAdmin(users)) throw new DernierAdminError();
    await commit(users);
    return modifie;
  });
}

export async function deleteUser(id: string): Promise<void> {
  return withFileLock(USERS_FILE, async () => {
    const users = (await readUsers()).filter((u) => u.id !== id);
    if (users.length === (await readUsers()).length) return; // déjà absent
    if (!resteUnAdmin(users)) throw new DernierAdminError();
    await commit(users);
  });
}

// ─── Invitations nominatives ───────────────────────────────────────────

export type InviteIssue = { token: string; expiresAt: number };

/**
 * Émet une invitation pour un utilisateur et renvoie le jeton EN CLAIR.
 *
 * C'est le seul instant où il existe en clair : seule son empreinte est
 * persistée. Un appel remplace l'invitation précédente — régénérer un lien
 * invalide donc l'ancien, ce qui est exactement ce qu'on veut quand un lien a
 * fuité.
 */
export async function issueInvite(userId: string, ttlMs = INVITE_TTL_MS): Promise<InviteIssue> {
  const token = createInviteToken();
  const expiresAt = Date.now() + ttlMs;
  await withFileLock(USERS_FILE, async () => {
    const users = [...(await readUsers())];
    const i = users.findIndex((u) => u.id === userId);
    if (i === -1) throw new Error('users: utilisateur introuvable');
    users[i] = {
      ...users[i],
      inviteHash: hashInviteToken(token),
      inviteExpiresAt: expiresAt,
      inviteUsedAt: null
    };
    await commit(users);
  });
  return { token, expiresAt };
}

/** Révoque l'invitation en cours — le lien cesse immédiatement de fonctionner. */
export async function revokeInvite(userId: string): Promise<void> {
  await withFileLock(USERS_FILE, async () => {
    const users = [...(await readUsers())];
    const i = users.findIndex((u) => u.id === userId);
    if (i === -1) return;
    users[i] = { ...users[i], inviteHash: null, inviteExpiresAt: null, inviteUsedAt: null };
    await commit(users);
  });
}

/**
 * Retrouve l'utilisateur ACTIF dont l'invitation valide correspond au jeton.
 *
 * Balayage linéaire avec comparaison à temps constant : le foyer compte une
 * poignée de comptes, et un index par empreinte n'apporterait rien qu'une
 * occasion de désynchronisation.
 */
export async function findUserByInviteToken(token: string): Promise<User | null> {
  if (!looksLikeInviteToken(token)) return null;
  const empreinte = hashInviteToken(token);
  const now = Date.now();
  for (const u of await readUsers()) {
    if (!u.inviteHash || u.status === 'revoked') continue;
    if (!inviteHashMatches(empreinte, u.inviteHash)) continue;
    if (u.inviteExpiresAt !== null && u.inviteExpiresAt <= now) return null; // périmée
    return u;
  }
  return null;
}

/**
 * Note la première entrée par le lien.
 *
 * L'invitation n'est PAS consommée (cf. le commentaire d'en-tête d'invite.ts :
 * les aperçus SMS/WhatsApp préchargent l'URL). Best-effort : un échec d'écriture
 * ne doit pas refuser une entrée par ailleurs légitime.
 */
export async function markInviteUsed(userId: string): Promise<void> {
  try {
    await withFileLock(USERS_FILE, async () => {
      const users = [...(await readUsers())];
      const i = users.findIndex((u) => u.id === userId);
      if (i === -1) return;
      const u = users[i];
      if (u.inviteUsedAt) return; // déjà noté, rien à réécrire
      users[i] = {
        ...u,
        inviteUsedAt: u.inviteUsedAt ?? new Date().toISOString()
      };
      await commit(users);
    });
  } catch (e) {
    console.error(`[users-store] invitation non horodatée pour ${userId}: ${(e as Error).message}`);
  }
}

/**
 * Granularité de `lastLoginAt`. En deçà, on ne réécrit pas le fichier.
 *
 * POURQUOI CE GARDE-FOU : `/auth` est une simple requête GET, et l'horodater
 * déclenche une écriture DURABLE complète (fsync du fichier, copie .bak, rename,
 * fsync du répertoire). N'importe quel appelant répétitif transforme donc une
 * page de connexion en marteau-pilon sur le disque. Ce n'est pas théorique : le
 * script de mesure `domo-mesures/trace-sb3loop.sh`, lancé par une crontab à la
 * minute, rouvrait une session à chaque passage — ~1440 cycles d'écriture par
 * jour pendant les neuf jours qui ont suivi la phase identité, et un
 * `lastLoginAt` qui horodatait un cron plutôt qu'une personne.
 *
 * Une heure de granularité suffit largement : cette date sert à savoir « quand
 * cette personne est-elle venue pour la dernière fois », jamais à la seconde.
 */
export const LAST_LOGIN_GRANULARITE_MS = 60 * 60 * 1000;

/** Horodate la connexion. Best-effort : un échec d'écriture ne doit pas
 *  refuser une session par ailleurs valide. */
export async function touchLastLogin(id: string): Promise<void> {
  try {
    await withFileLock(USERS_FILE, async () => {
      const users = [...(await readUsers())];
      const i = users.findIndex((u) => u.id === id);
      if (i === -1) return;

      // Déjà horodaté récemment → rien à écrire. Le contrôle est DANS le verrou :
      // deux connexions simultanées ne doivent pas décider chacune d'écrire.
      const precedent = users[i].lastLoginAt;
      if (precedent) {
        const age = Date.now() - Date.parse(precedent);
        if (Number.isFinite(age) && age >= 0 && age < LAST_LOGIN_GRANULARITE_MS) return;
      }

      users[i] = { ...users[i], lastLoginAt: new Date().toISOString() };
      await commit(users);
    });
  } catch (e) {
    console.error(`[users-store] lastLoginAt non enregistré pour ${id}: ${(e as Error).message}`);
  }
}
