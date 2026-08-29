/**
 * SESSION D'ÉCOUTE DE LA MAISON — un seul appareil joue à la fois.
 *
 * Le lecteur de Domo est local à chaque navigateur : sans arbitre, l'iPhone,
 * l'iPad et les appareils d'Isabelle jouaient chacun leur morceau. Constaté par
 * Laurent le 29/08 : « chacun lit un morceau différent […] c'est de la
 * cacophonie désorganisée », avec en prime deux appareils qui se disputent le
 * suivi lumineux du ruban.
 *
 * Règle retenue, celle d'AirPlay et de Spotify Connect : LE DERNIER QUI APPUIE
 * SUR LECTURE GAGNE. Il prend la session ; les autres se mettent en pause et
 * disent où la musique est partie. On ne synchronise pas la lecture entre
 * appareils (impossible proprement dans un navigateur) — on garantit qu'il n'y
 * en a qu'une.
 *
 * L'état est volontairement en mémoire : une session d'écoute ne survit pas à
 * un redémarrage du serveur, et c'est très bien — au retour, personne ne joue.
 */

export interface MusicSession {
  /** Identifiant stable de l'appareil qui joue (localStorage côté client). */
  deviceId: string;
  /** Nom lisible : « iPhone de Laurent ». */
  label: string;
  /** Titre en cours, pour que les autres écrans puissent le dire. */
  title: string;
  /** Dernier signe de vie (ms). */
  at: number;
}

/** Sans signe de vie depuis ce délai, la session est considérée abandonnée. */
const STALE_MS = 90_000;

type Listener = (s: MusicSession | null) => void;

/**
 * État porté par `globalThis` — même garde que les timers de music-mode : en
 * DEV, le HMR ré-évalue un module serveur et l'on se retrouve avec deux
 * instances, l'une servant le SSE et l'autre le POST. La diffusion partait
 * alors dans le vide (constaté au banc d'essai : le second appareil
 * revendiquait bien, le premier n'était jamais prévenu). Sans effet en
 * production (module chargé une fois), mais c'est la robustesse qui compte.
 */
interface SessionGlobals {
  current: MusicSession | null;
  listeners: Set<Listener>;
}
const G = globalThis as { __domoMusicSession?: SessionGlobals };
G.__domoMusicSession ??= { current: null, listeners: new Set() };
const store = G.__domoMusicSession;
const listeners = store.listeners;

function broadcast(): void {
  const snap = sessionState();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      /* abonné mort — retiré par son cancel() */
    }
  }
}

/** La session courante, ou null si personne ne joue (ou session périmée). */
export function sessionState(): MusicSession | null {
  const cur = store.current;
  if (!cur) return null;
  if (Date.now() - cur.at > STALE_MS) {
    store.current = null;
    return null;
  }
  return { ...cur };
}

/**
 * Un appareil prend (ou garde) la main. Renvoie l'état résultant — le client
 * n'a pas besoin d'attendre le SSE pour savoir qu'il a la session.
 */
export function claim(deviceId: string, label: string, title: string): MusicSession {
  const changed = !store.current || store.current.deviceId !== deviceId;
  store.current = { deviceId, label, title, at: Date.now() };
  if (changed) console.log(`[musique] session prise par ${label}`);
  broadcast();
  return { ...store.current };
}

/** Signe de vie : garde la session vivante sans rien changer d'autre. */
export function ping(deviceId: string, title: string): MusicSession | null {
  const cur = store.current;
  if (!cur || cur.deviceId !== deviceId) return sessionState();
  cur.at = Date.now();
  if (title && title !== cur.title) {
    cur.title = title;
    broadcast(); // le titre a changé : les autres écrans l'affichent
  }
  return { ...cur };
}

/** L'appareil arrête de jouer. Ne fait rien s'il n'avait pas la session. */
export function release(deviceId: string): void {
  const cur = store.current;
  if (!cur || cur.deviceId !== deviceId) return;
  console.log(`[musique] session libérée par ${cur.label}`);
  store.current = null;
  broadcast();
}

export function subscribeSession(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** « laurent@feroux.fr » → « Laurent » (aucun prénom n'est stocké ailleurs). */
export function prenomFromEmail(email: string | null | undefined): string | null {
  const local = (email ?? '')
    .split('@')[0]
    ?.replace(/[._-]+/g, ' ')
    .trim();
  if (!local) return null;
  return local.charAt(0).toUpperCase() + local.slice(1);
}
