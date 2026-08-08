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

const USERS_FILE = path.resolve(process.cwd(), 'data', 'users.json');

export type UserRole = 'admin' | 'famille';
export type UserStatus = 'active' | 'invited' | 'revoked';

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
const STATUSES: readonly UserStatus[] = ['active', 'invited', 'revoked'];

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
    if (!STATUSES.includes(u.status as UserStatus)) continue;
    users.push({
      id: u.id,
      email: u.email,
      role: u.role as UserRole,
      status: u.status as UserStatus,
      pinHash: typeof u.pinHash === 'string' ? u.pinHash : null,
      pinSalt: typeof u.pinSalt === 'string' ? u.pinSalt : null,
      pinAttempts: typeof u.pinAttempts === 'number' ? u.pinAttempts : 0,
      pinLockedUntil: typeof u.pinLockedUntil === 'number' ? u.pinLockedUntil : null,
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
      status: input.status ?? 'invited',
      pinHash: null,
      pinSalt: null,
      pinAttempts: 0,
      pinLockedUntil: null,
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };
    users.push(user);
    await commit(users);
    return user;
  });
}

/** Horodate la connexion. Best-effort : un échec d'écriture ne doit pas
 *  refuser une session par ailleurs valide. */
export async function touchLastLogin(id: string): Promise<void> {
  try {
    await withFileLock(USERS_FILE, async () => {
      const users = [...(await readUsers())];
      const i = users.findIndex((u) => u.id === id);
      if (i === -1) return;
      users[i] = { ...users[i], lastLoginAt: new Date().toISOString() };
      await commit(users);
    });
  } catch (e) {
    console.error(`[users-store] lastLoginAt non enregistré pour ${id}: ${(e as Error).message}`);
  }
}
