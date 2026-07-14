/**
 * Accès serveur au Plex Media Server (musique) du RPi4, via Tailscale (PLEX_URL).
 *
 * Auth SANS extraction du token serveur (règle absolue de la maison) : appairage
 * officiel plex.tv/link — Domo crée un PIN (POST plex.tv/api/v2/pins), Laurent
 * saisit le code sur https://plex.tv/link, et le poll du PIN renvoie un token
 * applicatif « Domo » propre. Ce token est stocké dans data/plex-auth.json
 * (gitignored) et ne quitte JAMAIS le serveur : le client ne parle qu'au proxy
 * /api/plex/*, qui ajoute le token côté node.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { readJsonSafe, writeJsonAtomic } from './atomic-store';

const AUTH_FILE = path.resolve(process.cwd(), 'data', 'plex-auth.json');
const PLEXTV = 'https://plex.tv';
const TIMEOUT_MS = 10_000;

/** Erreur typée : les routes la convertissent en `error(status, message)`. */
export class PlexError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

interface PlexAuth {
  /** Identifiant client STABLE (X-Plex-Client-Identifier) — généré une fois. */
  clientId: string;
  token: string | null;
  linkedAt: string | null;
}

let authCache: PlexAuth | null = null;

async function loadAuth(): Promise<PlexAuth> {
  if (authCache) return authCache;
  authCache = await readJsonSafe<PlexAuth>(AUTH_FILE, {
    fallback: () => ({ clientId: randomUUID(), token: null, linkedAt: null }),
    normalize: (raw) => {
      const r = raw as Partial<PlexAuth>;
      return {
        clientId: typeof r.clientId === 'string' && r.clientId ? r.clientId : randomUUID(),
        token: typeof r.token === 'string' && r.token ? r.token : null,
        linkedAt: typeof r.linkedAt === 'string' ? r.linkedAt : null
      };
    },
    label: 'plex-auth.json'
  });
  // Persiste le clientId fraîchement généré (sinon il changerait à chaque boot
  // et l'appairage plex.tv, lié au client-identifier, deviendrait instable).
  await writeJsonAtomic(AUTH_FILE, authCache);
  return authCache;
}

async function saveAuth(a: PlexAuth): Promise<void> {
  authCache = a;
  await writeJsonAtomic(AUTH_FILE, a);
}

export function plexBase(): string | null {
  const u = (env.PLEX_URL || '').trim().replace(/\/+$/, '');
  return u || null;
}

/** En-têtes d'identité de l'app — mêmes valeurs pour plex.tv (pins) et le PMS. */
async function identityHeaders(): Promise<Record<string, string>> {
  const { clientId } = await loadAuth();
  return {
    'X-Plex-Product': 'Domo',
    'X-Plex-Version': '1.0',
    'X-Plex-Client-Identifier': clientId,
    'X-Plex-Device': 'Domo',
    'X-Plex-Device-Name': 'Domo (domo.feroux.fr)',
    'X-Plex-Platform': 'Web',
    accept: 'application/json'
  };
}

export async function isLinked(): Promise<boolean> {
  return !!(await loadAuth()).token;
}

export async function linkedAt(): Promise<string | null> {
  return (await loadAuth()).linkedAt;
}

/** Crée un PIN d'appairage (code court à saisir sur plex.tv/link, valable 15 min). */
export async function createPin(): Promise<{ id: number; code: string }> {
  const res = await fetch(`${PLEXTV}/api/v2/pins?strong=false`, {
    method: 'POST',
    headers: await identityHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new PlexError(502, `plex.tv: HTTP ${res.status}`);
  const j = (await res.json()) as { id?: number; code?: string };
  if (!j.id || !j.code) throw new PlexError(502, 'plex.tv: réponse PIN invalide');
  return { id: j.id, code: j.code };
}

/** Poll d'un PIN ; si l'utilisateur a saisi le code, stocke le token et répond true. */
export async function checkPin(id: number): Promise<boolean> {
  const res = await fetch(`${PLEXTV}/api/v2/pins/${id}`, {
    headers: await identityHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  // 404 = PIN expiré/inconnu → simplement « pas encore lié » (l'UI recrée un code).
  if (!res.ok) return false;
  const j = (await res.json()) as { authToken?: string | null };
  if (!j.authToken) return false;
  const a = await loadAuth();
  await saveAuth({ ...a, token: j.authToken, linkedAt: new Date().toISOString() });
  sectionCache = null;
  return true;
}

/** Oublie le token applicatif (l'utilisateur peut aussi révoquer côté plex.tv). */
export async function unlink(): Promise<void> {
  const a = await loadAuth();
  await saveAuth({ ...a, token: null, linkedAt: null });
  sectionCache = null;
}

/**
 * fetch authentifié vers le PMS. `timeoutMs: 0` = pas de timeout (streaming).
 * Jette PlexError(503) si PLEX_URL absent, (401) si non appairé.
 */
export async function pmsFetch(
  pathname: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const base = plexBase();
  if (!base) throw new PlexError(503, 'PLEX_URL non configuré');
  const { token } = await loadAuth();
  if (!token) throw new PlexError(401, 'Domo n’est pas appairé à Plex');
  const { timeoutMs, headers, ...rest } = init;
  const t = timeoutMs ?? TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${base}${pathname}`, {
      ...rest,
      headers: {
        ...(await identityHeaders()),
        'X-Plex-Token': token,
        ...(headers as Record<string, string> | undefined)
      },
      ...(t > 0 ? { signal: AbortSignal.timeout(t) } : {})
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'réseau';
    throw new PlexError(504, `Plex injoignable (${reason})`);
  }
  // Token révoqué côté plex.tv → l'UI doit proposer un ré-appairage.
  if (res.status === 401) throw new PlexError(401, 'Appairage Plex expiré ou révoqué');
  return res;
}

// ─── Section musicale ────────────────────────────────────────────────────────

export interface MusicSection {
  key: string;
  title: string;
  /** Racines de la bibliothèque VUES PAR LE CONTENEUR Plex (ex. /media/music). */
  locations: string[];
}

let sectionCache: { section: MusicSection; at: number } | null = null;
const SECTION_TTL_MS = 6 * 60 * 60 * 1000;

/** Trouve la bibliothèque de type `artist` (musique) — clé + racines, caché 6 h. */
export async function musicSection(): Promise<MusicSection> {
  if (sectionCache && Date.now() - sectionCache.at < SECTION_TTL_MS) return sectionCache.section;
  const res = await pmsFetch('/library/sections');
  if (!res.ok) throw new PlexError(502, `Plex: HTTP ${res.status}`);
  const j = (await res.json()) as {
    MediaContainer?: {
      Directory?: Array<{
        key: string;
        type: string;
        title: string;
        Location?: Array<{ path: string }>;
      }>;
    };
  };
  const dir = j.MediaContainer?.Directory?.find((d) => d.type === 'artist');
  if (!dir) throw new PlexError(502, 'Aucune bibliothèque musicale sur ce serveur Plex');
  const section: MusicSection = {
    key: String(dir.key),
    title: dir.title,
    locations: (dir.Location ?? []).map((l) => l.path)
  };
  sectionCache = { section, at: Date.now() };
  return section;
}

// ─── Accès disque RPi4 (upload / suppression de secours) ────────────────────

/** Config SSH vers le RPi4 (tunnel réverse), depuis .env. */
export function sshTarget(): { host: string; port: string; musicRoot: string } | null {
  const host = (env.PLEX_SSH_HOST || '').trim();
  const port = (env.PLEX_SSH_PORT || '22').trim();
  const musicRoot = (env.PLEX_HOST_MUSIC_PATH || '').trim().replace(/\/+$/, '');
  if (!host || !musicRoot) return null;
  return { host, port, musicRoot };
}

/** Quote un argument pour le shell DISTANT (ssh concatène ses args en une commande). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Traduit un chemin de fichier VU PAR LE CONTENEUR Plex (ex. /media/music/…)
 * vers le chemin hôte RPi (ex. /mnt/medias/music/…), en refusant tout ce qui
 * sort de la racine musicale (défense en profondeur avant un rm distant).
 */
export async function containerPathToHost(containerPath: string): Promise<string> {
  const ssh = sshTarget();
  if (!ssh) throw new PlexError(503, 'PLEX_SSH_HOST / PLEX_HOST_MUSIC_PATH non configurés');
  const { locations } = await musicSection();
  const root = locations.find((l) => containerPath.startsWith(l + '/'));
  if (!root) throw new PlexError(400, 'Chemin hors de la bibliothèque musicale');
  const rel = containerPath.slice(root.length);
  if (rel.includes('..')) throw new PlexError(400, 'Chemin invalide');
  return ssh.musicRoot + rel;
}
