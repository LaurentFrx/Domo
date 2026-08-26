/**
 * Store Plex (musique) — bibliothèque + LECTEUR audio global « PlexAmp maison ».
 *
 * Deux singletons :
 *   - `plex`   : état de l'intégration (appairage plex.tv/link), bibliothèque
 *                (récents, albums paginés, artistes, recherche) et gestion
 *                (upload, suppression, scan). Cycle de vie refcounté (acquire).
 *   - `player` : file de lecture + platines audio MODULE-LEVEL (jamais montées
 *                dans le DOM) → la musique survit aux swipes du pager et aux
 *                navigations. MediaSession pour l'écran verrouillé iOS.
 *                Fondus enchaînés : DEUX platines dans un graphe Web Audio
 *                (GainNode chacune — el.volume est verrouillé sur iOS), durée
 *                réglable + mode intelligent calé sur l'analyse de sonie du
 *                PMS (rampes intro/outro via /api/plex/fade).
 *
 * Pas de polling continu : la bibliothèque est statique, on (re)charge à la
 * demande + au retour de visibilité si l'état n'était pas prêt. Le token Plex
 * ne transite JAMAIS ici : tout passe par le proxy authentifié /api/plex/*.
 */

import { preferences } from './preferences.svelte';
import {
  equalPowerCurve,
  introSilenceS,
  levelFrom,
  outroLeadS,
  type TrackFadeInfo
} from '$utils/fade';

/** Fichier à envoyer + chemin relatif (sous-dossier d'album préservé). */
export interface UploadItem {
  file: File;
  /** Chemin relatif style `Artiste - Album/01 - Titre.flac` ; défaut : nom du fichier. */
  path?: string;
}

/** Taille max d'une requête d'upload — marge sous BODY_SIZE_LIMIT (512M). */
const UPLOAD_BATCH_BYTES = 400 * 1024 * 1024;

/** Échecs de lecture CONSÉCUTIFS avant d'arrêter d'égrener la file (panne générale). */
const MAX_PLAYBACK_FAILURES = 3;

/** Préchargement du morceau suivant sur la platine libre (s avant la fin). */
const PRELOAD_S = 20;
/** Plancher d'un fondu intelligent (s) — une fin sèche enchaîne vite, sans claquer. */
const MIN_SMART_FADE_S = 0.6;
/** DJ automatique : la suite est demandée quand la DERNIÈRE piste entre dans
 *  cette fenêtre (s avant la fin) — assez tôt pour précharger et fondre. */
const DJ_EXTEND_S = 25;
/** DJ automatique : morceaux ajoutés par fournée. */
const DJ_BATCH = 20;
/** Station qui alimente le DJ : « Radio de la maison » (smart shuffle pondéré). */
const DJ_STATION_ID = 1;

export interface PlexAlbum {
  key: string;
  title: string;
  artist: string;
  artistKey: string | null;
  year: number | null;
  thumb: string | null;
  tracks: number | null;
}

export interface PlexArtist {
  key: string;
  title: string;
  thumb: string | null;
  albums: number | null;
}

export interface PlexTrack {
  key: string;
  title: string;
  index: number | null;
  disc: number | null;
  /** ms (convention PMS) */
  duration: number | null;
  artist: string;
  album: string;
  albumKey: string | null;
  thumb: string | null;
  part: string | null;
  codec: string | null;
  /** kbps (convention PMS). */
  bitrate: number | null;
  /** Octets. */
  size: number | null;
  /** Chemin disque (info « fichier » du pop-up). */
  file: string | null;
  /** Identifiant de LIGNE quand la piste vient d'une playlist (retrait/déplacement). */
  playlistItemId: number | null;
}

export interface PlexSearchResults {
  artists: PlexArtist[];
  albums: PlexAlbum[];
  tracks: PlexTrack[];
}

export interface PlexPlaylist {
  key: string;
  title: string;
  /** Intelligente (règles Plex, mise à jour automatique, non éditable à la main). */
  smart: boolean;
  count: number | null;
  /** Durée totale en ms. */
  duration: number | null;
  /** Mosaïque de pochettes (chemin composite, à passer à plexImg). */
  thumb: string | null;
}

/** Règles de mix/playlist intelligente (miroir de src/lib/server/plex-smart.ts). */
export interface SmartRules {
  yearFrom?: number;
  yearTo?: number;
  addedDays?: number;
  notPlayedDays?: number;
  playedOnly?: boolean;
  neverPlayed?: boolean;
  minRating?: number;
  sort?: 'random' | 'added' | 'plays' | 'alpha' | 'recent';
  limit?: number;
}

export interface SmartPreset {
  id: string;
  label: string;
  desc: string;
  /** Teinte OKLCH de la tuile (accents lumineux de la charte). */
  hue: number;
  rules: SmartRules;
}

/** Mix intelligents « une touche » (façon PlexAmp) — lecture immédiate.
 *  « Jamais écoutés » ouvre le rail (demande Laurent, 25/08). */
export const SMART_PRESETS: SmartPreset[] = [
  {
    id: 'inexplores',
    label: 'Jamais écoutés',
    desc: 'Les terres inconnues de la bibliothèque',
    hue: 350,
    rules: { neverPlayed: true, sort: 'random', limit: 100 }
  },
  {
    id: 'mix',
    label: 'Mix aléatoire',
    desc: 'Toute la bibliothèque, au hasard',
    hue: 293,
    rules: { sort: 'random', limit: 100 }
  },
  {
    id: 'fresh',
    label: 'Ajouts du mois',
    desc: 'Le plus récent d’abord',
    hue: 200,
    rules: { addedDays: 30, sort: 'added', limit: 100 }
  },
  {
    id: 'top',
    label: 'Les plus écoutés',
    desc: 'Les valeurs sûres de la maison',
    hue: 60,
    rules: { playedOnly: true, sort: 'plays', limit: 50 }
  },
  {
    id: 'redecouvertes',
    label: 'Redécouvertes',
    desc: 'Écoutés autrefois, oubliés depuis 3 mois',
    hue: 152,
    rules: { notPlayedDays: 90, sort: 'random', limit: 50 }
  }
];

/** Une station radio du PMS (les « DJ » de PlexAmp) — ids canoniques Plex,
 *  vérifiés présents sur ce serveur via le hub `music.stations`. */
export interface RadioStation {
  id: number;
  label: string;
  desc: string;
  /** Teinte OKLCH de la tuile (accents lumineux de la charte). */
  hue: number;
}

export const RADIO_STATIONS: RadioStation[] = [
  {
    id: 1,
    label: 'Radio de la maison',
    desc: 'Toute la bibliothèque, guidée par vos écoutes',
    hue: 262
  },
  { id: 8, label: 'Pépites cachées', desc: 'Les titres profonds, loin des tubes', hue: 20 },
  { id: 2, label: 'Voyage dans le temps', desc: 'D’époque en époque, sans prévenir', hue: 120 },
  { id: 3, label: 'Albums surprise', desc: 'Des albums entiers, au hasard', hue: 230 }
];

/** URL proxy d'une pochette (null → pas d'image, l'UI met un dégradé). */
export function plexImg(thumb: string | null | undefined, size = 300): string | null {
  return thumb ? `/api/plex/image?path=${encodeURIComponent(thumb)}&size=${size}` : null;
}

/** URL proxy du flux audio d'une piste (part = /library/parts/…/file.ext). */
export function streamUrl(part: string): string {
  return `/api/plex/stream${part}`;
}

/** mm:ss depuis des millisecondes (durées PMS). */
export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '–:––';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type PlexUiStatus =
  | 'idle'
  | 'loading'
  | 'unconfigured'
  | 'unlinked'
  | 'ready'
  | 'offline'
  | 'error';

interface StatusJson {
  configured: boolean;
  linked: boolean;
  online: boolean;
  needsRelink: boolean;
  server?: { name: string; version: string | null };
  section?: { key: string; title: string };
  error?: string;
}

const PIN_POLL_MS = 2_000;

class PlexState {
  status = $state<PlexUiStatus>('idle');
  serverName = $state<string | null>(null);
  lastError = $state<string | null>(null);

  /** Appairage en cours : code à saisir sur plex.tv/link. */
  pin = $state<{ id: number; code: string } | null>(null);

  recents = $state<PlexAlbum[]>([]);
  albums = $state<PlexAlbum[]>([]);
  albumsTotal = $state(0);
  artists = $state<PlexArtist[]>([]);
  playlists = $state<PlexPlaylist[]>([]);

  /** Upload en cours (mode Gérer) : progression 0–1, ou null. */
  uploadProgress = $state<number | null>(null);

  private pinTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private albumCache = new Map<string, { album: PlexAlbum; tracks: PlexTrack[] }>();
  private artistCache = new Map<string, PlexAlbum[]>();
  private playlistCache = new Map<string, { playlist: PlexPlaylist; tracks: PlexTrack[] }>();

  connect() {
    if (typeof window === 'undefined') return;
    void this.refresh();
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      // Au retour : re-tente si on n'était pas prêt (serveur revenu, appairage fait
      // ailleurs…). L'état `ready` n'est PAS re-sondé — bibliothèque statique.
      if (this.status !== 'ready') void this.refresh();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  disconnect() {
    this.stopPinPolling();
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /** (Re)charge le statut, puis la bibliothèque si prêt. */
  async refresh(): Promise<void> {
    if (this.status === 'idle') this.status = 'loading';
    try {
      const res = await fetch('/api/plex/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = (await res.json()) as StatusJson;
      this.serverName = s.server?.name ?? this.serverName;
      this.lastError = s.error ?? null;
      if (!s.configured) {
        this.status = 'unconfigured';
      } else if (!s.linked || s.needsRelink) {
        this.status = 'unlinked';
        void this.startLink();
      } else if (!s.online) {
        this.status = 'offline';
      } else {
        this.status = 'ready';
        this.stopPinPolling();
        this.pin = null;
        await this.loadLibrary();
      }
    } catch (e) {
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }

  private async loadLibrary(): Promise<void> {
    const [recents, albums, artists] = await Promise.all([
      this.browse('view=recent&limit=20'),
      this.browse('view=albums&limit=60'),
      this.browse('view=artists&limit=200'),
      this.loadPlaylists()
    ]);
    this.recents = recents.items as PlexAlbum[];
    this.albums = albums.items as PlexAlbum[];
    this.albumsTotal = albums.total;
    this.artists = artists.items as PlexArtist[];
  }

  /** Appel API JSON avec message d'erreur serveur remonté tel quel. */
  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, { cache: 'no-store', ...init });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        message = ((await res.json()) as { message?: string }).message ?? message;
      } catch {
        /* corps non JSON */
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  private post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
    return this.api<T>(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  private async browse(qs: string): Promise<{ items: unknown[]; total: number }> {
    const res = await fetch(`/api/plex/browse?${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { items: unknown[]; total: number };
  }

  /** Pagination « Afficher plus » de la grille d'albums. */
  async loadMoreAlbums(): Promise<void> {
    if (this.albums.length >= this.albumsTotal) return;
    const page = await this.browse(`view=albums&offset=${this.albums.length}&limit=60`);
    this.albums = [...this.albums, ...(page.items as PlexAlbum[])];
    this.albumsTotal = page.total;
  }

  /** Albums d'un artiste (caché). */
  async artistAlbums(artistKey: string): Promise<PlexAlbum[]> {
    const cached = this.artistCache.get(artistKey);
    if (cached) return cached;
    const r = await this.browse(`view=artist&key=${artistKey}`);
    const list = r.items as PlexAlbum[];
    this.artistCache.set(artistKey, list);
    return list;
  }

  /** Détail d'un album + pistes (caché). */
  async album(key: string): Promise<{ album: PlexAlbum; tracks: PlexTrack[] }> {
    const cached = this.albumCache.get(key);
    if (cached) return cached;
    const res = await fetch(`/api/plex/album/${key}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const detail = (await res.json()) as { album: PlexAlbum; tracks: PlexTrack[] };
    this.albumCache.set(key, detail);
    return detail;
  }

  // ─── Playlists (classiques + intelligentes) ───────────────────────────────

  async loadPlaylists(): Promise<void> {
    const { items } = await this.api<{ items: PlexPlaylist[] }>('/api/plex/playlists');
    this.playlists = items;
  }

  /** Détail d'une playlist + pistes (avec playlistItemId). `fresh` court-circuite le cache. */
  async playlist(
    key: string,
    fresh = false
  ): Promise<{ playlist: PlexPlaylist; tracks: PlexTrack[] }> {
    if (!fresh) {
      const cached = this.playlistCache.get(key);
      if (cached) return cached;
    }
    const detail = await this.api<{ playlist: PlexPlaylist; tracks: PlexTrack[] }>(
      `/api/plex/playlists/${key}`
    );
    this.playlistCache.set(key, detail);
    return detail;
  }

  async createPlaylist(title: string, keys: string[]): Promise<PlexPlaylist> {
    const { playlist } = await this.post<{ playlist: PlexPlaylist }>('/api/plex/playlists', {
      title,
      keys
    });
    await this.loadPlaylists();
    return playlist;
  }

  async createSmartPlaylist(title: string, rules: SmartRules): Promise<PlexPlaylist> {
    const { playlist } = await this.post<{ playlist: PlexPlaylist }>('/api/plex/playlists', {
      title,
      smart: rules
    });
    await this.loadPlaylists();
    return playlist;
  }

  /** Pistes d'un mix intelligent SANS créer de playlist (presets, aperçu). */
  async smartTracks(rules: SmartRules): Promise<PlexTrack[]> {
    const { tracks } = await this.post<{ tracks: PlexTrack[] }>('/api/plex/smart', { rules });
    return tracks;
  }

  /** Pistes d'une station radio Plex (tuiles « Radios » — smart shuffle serveur). */
  async stationTracks(id: number, limit = 100): Promise<PlexTrack[]> {
    const { tracks } = await this.api<{ tracks: PlexTrack[] }>(
      `/api/plex/station/${id}?limit=${limit}`
    );
    return tracks;
  }

  async addToPlaylist(playlistKey: string, keys: string[]): Promise<void> {
    await this.post(`/api/plex/playlists/${playlistKey}/items`, { keys });
    this.playlistCache.delete(playlistKey);
    await this.loadPlaylists();
  }

  async removePlaylistItem(playlistKey: string, itemId: number): Promise<void> {
    await this.api(`/api/plex/playlists/${playlistKey}/items/${itemId}`, { method: 'DELETE' });
    this.playlistCache.delete(playlistKey);
    await this.loadPlaylists();
  }

  /** Déplace une ligne après `afterItemId` (null = tout en haut). */
  async movePlaylistItem(
    playlistKey: string,
    itemId: number,
    afterItemId: number | null
  ): Promise<void> {
    await this.post(
      `/api/plex/playlists/${playlistKey}/items/${itemId}`,
      { after: afterItemId ? String(afterItemId) : null },
      'PUT'
    );
    this.playlistCache.delete(playlistKey);
  }

  async renamePlaylist(playlistKey: string, title: string): Promise<void> {
    await this.post(`/api/plex/playlists/${playlistKey}`, { title }, 'PUT');
    this.playlistCache.delete(playlistKey);
    await this.loadPlaylists();
  }

  /** Supprime la playlist (les fichiers musicaux ne sont jamais touchés). */
  async deletePlaylist(playlistKey: string): Promise<void> {
    await this.api(`/api/plex/playlists/${playlistKey}`, { method: 'DELETE' });
    this.playlistCache.delete(playlistKey);
    await this.loadPlaylists();
  }

  async search(q: string): Promise<PlexSearchResults> {
    const res = await fetch(`/api/plex/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as PlexSearchResults;
  }

  // ─── Appairage plex.tv/link ────────────────────────────────────────────────

  async startLink(): Promise<void> {
    if (this.pin || this.pinTimer) return; // déjà en cours
    try {
      const res = await fetch('/api/plex/link', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.pin = (await res.json()) as { id: number; code: string };
      this.schedulePinPoll();
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  private schedulePinPoll(): void {
    this.pinTimer = setTimeout(async () => {
      this.pinTimer = null;
      const pin = this.pin;
      if (!pin || this.status === 'ready') return;
      try {
        const res = await fetch(`/api/plex/link?id=${pin.id}`, { cache: 'no-store' });
        if (res.ok) {
          const { linked } = (await res.json()) as { linked: boolean };
          if (linked) {
            this.pin = null;
            await this.refresh();
            return;
          }
        }
      } catch {
        /* réseau : on réessaie au prochain tick */
      }
      this.schedulePinPoll();
    }, PIN_POLL_MS);
  }

  private stopPinPolling(): void {
    if (this.pinTimer) {
      clearTimeout(this.pinTimer);
      this.pinTimer = null;
    }
  }

  /** Le PIN expire côté plex.tv (~15 min) : en redemander un neuf. */
  async renewPin(): Promise<void> {
    this.stopPinPolling();
    this.pin = null;
    await this.startLink();
  }

  // ─── Gestion de la bibliothèque (mode Gérer) ──────────────────────────────

  /**
   * Upload de fichiers audio (avec leur chemin relatif : un dossier d'album
   * arrive entier, pochette comprise) et progression globale. L'envoi est
   * découpé en lots pour rester sous BODY_SIZE_LIMIT même sur un album 24 bits.
   * Résout avec les chemins enregistrés et les fichiers ignorés côté serveur.
   */
  async upload(items: UploadItem[]): Promise<{ saved: string[]; skipped: string[] }> {
    const totalBytes = items.reduce((s, it) => s + it.file.size, 0);
    const batches: UploadItem[][] = [];
    let batch: UploadItem[] = [];
    let batchBytes = 0;
    for (const it of items) {
      if (batch.length > 0 && batchBytes + it.file.size > UPLOAD_BATCH_BYTES) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(it);
      batchBytes += it.file.size;
    }
    if (batch.length > 0) batches.push(batch);

    this.uploadProgress = 0;
    let doneBytes = 0;
    const saved: string[] = [];
    const skipped: string[] = [];
    try {
      for (const b of batches) {
        const res = await this.uploadBatch(b, (loaded) => {
          this.uploadProgress = totalBytes > 0 ? Math.min(1, (doneBytes + loaded) / totalBytes) : 1;
        });
        saved.push(...res.saved);
        skipped.push(...res.skipped);
        doneBytes += b.reduce((s, it) => s + it.file.size, 0);
      }
    } finally {
      this.uploadProgress = null;
    }
    // Les nouveautés apparaîtront dans « récents » après le scan.
    setTimeout(() => void this.reloadQuiet(), 4_000);
    return { saved, skipped };
  }

  /** Un lot = une requête (XMLHttpRequest — fetch n'expose pas la progression). */
  private uploadBatch(
    items: UploadItem[],
    onProgress: (loadedBytes: number) => void
  ): Promise<{ saved: string[]; skipped: string[] }> {
    const form = new FormData();
    for (const it of items) {
      form.append('files', it.file);
      form.append('paths', it.path ?? it.file.name);
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/plex/upload');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) onProgress(ev.loaded);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const j = JSON.parse(xhr.responseText) as { saved: string[]; skipped?: string[] };
          resolve({ saved: j.saved, skipped: j.skipped ?? [] });
        } else {
          let message = `HTTP ${xhr.status}`;
          try {
            message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message;
          } catch {
            /* corps non JSON */
          }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('Envoi interrompu'));
      xhr.send(form);
    });
  }

  /** Supprime un album ou une piste (fichiers compris), puis recharge les listes. */
  async deleteItem(key: string): Promise<void> {
    const res = await fetch(`/api/plex/item/${key}`, { method: 'DELETE' });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        message = ((await res.json()) as { message?: string }).message ?? message;
      } catch {
        /* corps non JSON */
      }
      throw new Error(message);
    }
    // La clé supprimée peut être une PISTE : son album (autre clé) garderait la
    // piste fantôme en cache → on vide tout, les vues rechargent à la demande.
    // Les playlists aussi : Plex retire lui-même la piste supprimée de leurs
    // items, un détail caché servirait des pistes fantômes à la réouverture.
    this.albumCache.clear();
    this.artistCache.clear();
    this.playlistCache.clear();
    await this.reloadQuiet();
  }

  /** Lance une analyse complète de la bibliothèque. */
  async scan(): Promise<void> {
    const res = await fetch('/api/plex/scan', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setTimeout(() => void this.reloadQuiet(), 5_000);
  }

  /** Recharge les listes sans toucher au statut affiché. */
  private async reloadQuiet(): Promise<void> {
    if (this.status !== 'ready') return;
    try {
      await this.loadLibrary();
    } catch {
      /* silencieux : la prochaine action naturelle rechargera */
    }
  }
}

// ─── Lecteur ─────────────────────────────────────────────────────────────────

class PlayerState {
  queue = $state<PlexTrack[]>([]);
  index = $state(0);
  playing = $state(false);
  /** Position et durée en SECONDES (l'élément audio parle en secondes). */
  currentTime = $state(0);
  duration = $state(0);
  shuffle = $state(false);
  repeat = $state<'off' | 'all' | 'one'>('off');
  /** Libellé du contexte de lecture (« Album — Artiste ») pour le mini-player. */
  context = $state<string | null>(null);
  lastError = $state<string | null>(null);
  /** Avis transitoire « piste sautée » (la lecture, elle, continue). */
  skipNotice = $state<string | null>(null);
  /** Feuille « Now Playing » plein écran ouverte ? (UI globale) */
  sheetOpen = $state(false);
  /** Sélecteur de destination dispo ('airplay' WebKit iOS/macOS, 'remote' ailleurs). */
  outputPicker = $state<'airplay' | 'remote' | null>(null);
  /** Lecture envoyée vers un appareil sans fil (AirPlay, Cast…) ? */
  wirelessOutput = $state(false);

  current = $derived<PlexTrack | null>(this.queue[this.index] ?? null);

  /**
   * DEUX platines (façon DJ) : l'active joue la piste courante, l'autre
   * précharge la suivante puis monte pendant le fondu enchaîné. Tant que le
   * fondu est désactivé, seule la platine 0 existe — comportement historique.
   */
  private decks: Deck[] = [];
  /** Index de la platine ACTIVE (celle de la piste courante). */
  private active = 0;
  /** Graphe Web Audio — SEUL moyen de doser le volume sur iOS (el.volume y est verrouillé). */
  private ctx: AudioContext | null = null;
  /** Éléments capturés dans le graphe ? (irréversible pour la session) */
  private captured = false;
  /** Fondu en cours : la platine sortante finit de s'éteindre. */
  private fading = false;
  /** Clé de la piste préchargée sur la platine libre (null = rien de prêt). */
  private preloadedKey: string | null = null;
  /** Analyses de sonie par piste (null mémorisé = piste sans analyse/en échec). */
  private fadeCache = new Map<string, TrackFadeInfo | null>();
  private fadeInflight = new Map<string, Promise<TrackFadeInfo | null>>();
  /** Échecs de lecture consécutifs (remis à zéro dès que du son sort). */
  private failStreak = 0;
  private skipNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Élément audio ACTIF paresseux (client uniquement) — init au premier appel. */
  private ensureAudio(): HTMLAudioElement {
    if (this.decks.length === 0) {
      // iOS (Audio Session API, WebKit) : déclarer la session « playback », sinon
      // la PWA plein écran COUPE le son dès qu'on passe sur une autre app, et le
      // commutateur silence le mute. Sans effet ailleurs (API absente = ignoré).
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
      this.decks.push(this.createDeck());
      this.setupMediaSession();
    }
    return this.decks[this.active].el;
  }

  /** La platine libre (préchargement / fondu) — null tant que le graphe n'existe pas. */
  private otherDeck(): Deck | null {
    return this.decks[1 - this.active] ?? null;
  }

  private isActiveEl(a: HTMLAudioElement): boolean {
    return this.decks[this.active]?.el === a;
  }

  /** Crée un élément audio + ses écouteurs. Les écouteurs d'état ne parlent que
   *  pour la platine ACTIVE : pendant un fondu, la sortante joue encore et ses
   *  événements (pause, ended…) ne doivent pas piloter l'UI. */
  private createDeck(): Deck {
    const a = new Audio();
    a.preload = 'auto';
    const deck: Deck = { el: a, gain: null };
    a.addEventListener('timeupdate', () => {
      if (!this.isActiveEl(a)) return;
      this.currentTime = a.currentTime;
      this.onTick(a);
    });
    a.addEventListener('durationchange', () => {
      if (this.isActiveEl(a)) this.duration = a.duration || 0;
    });
    a.addEventListener('play', () => {
      // Assurance : un contexte suspendu rendrait les éléments capturés muets.
      if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      if (!this.isActiveEl(a)) return;
      this.playing = true;
      this.syncMediaSessionState();
    });
    // Du son SORT vraiment : efface un diagnostic d'échec précédent (le
    // navigateur peut réussir une reprise après une erreur transitoire) et
    // referme la série d'échecs consécutifs.
    a.addEventListener('playing', () => {
      if (!this.isActiveEl(a)) return;
      this.lastError = null;
      this.failStreak = 0;
    });
    a.addEventListener('pause', () => {
      if (!this.isActiveEl(a)) return;
      this.playing = false;
      this.syncMediaSessionState();
    });
    a.addEventListener('ended', () => {
      if (this.isActiveEl(a)) this.autoNext();
      else this.fading = false; // la sortante s'est éteinte : fondu terminé
    });
    a.addEventListener('error', () => {
      if (this.isActiveEl(a)) {
        this.playing = false;
        void this.handlePlaybackError(a);
      } else {
        // Préchargement raté : l'enchaînement retombera sur le chemin classique
        // (ended → next), qui porte le diagnostic et le saut de piste.
        this.preloadedKey = null;
      }
    });
    this.detectOutputPicker(a);
    return deck;
  }

  // ─── Graphe Web Audio (fondus + nivellement) ──────────────────────────────

  /**
   * Capture les platines dans un graphe Web Audio (un GainNode chacune).
   * Appelé sur GESTE utilisateur (autoplay policy iOS), seulement si un fondu
   * ou le nivellement est demandé, et jamais pendant une sortie AirPlay : une
   * fois capturé, un élément ne rend plus jamais son signal en direct — le
   * doute AirPlay+Web Audio se tranche sur appareil, pas ici.
   */
  private ensureGraph(): void {
    if (this.captured || this.wirelessOutput) return;
    if (preferences.musicFadeSeconds <= 0 && !preferences.musicLoudnessLeveling) return;
    if (typeof window === 'undefined' || !('AudioContext' in window)) return;
    this.ensureAudio();
    try {
      this.ctx ??= new AudioContext();
      if (this.decks.length < 2) this.decks.push(this.createDeck());
      for (const d of this.decks) {
        if (d.gain) continue;
        const src = this.ctx.createMediaElementSource(d.el);
        d.gain = this.ctx.createGain();
        src.connect(d.gain).connect(this.ctx.destination);
      }
      this.captured = true;
      void this.ctx.resume().catch(() => undefined);
      // iOS suspend le contexte au gré des interruptions (appel, Siri…) :
      // on le relance au retour de visibilité si la lecture est censée tourner.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.playing && this.ctx) {
          void this.ctx.resume().catch(() => undefined);
        }
      });
    } catch {
      // Graphe indisponible : lecture directe, sans fondu ni nivellement.
    }
  }

  /** Facteur de nivellement d'une piste (1 si réglage coupé ou analyse absente du cache). */
  private levelFor(key: string | null | undefined): number {
    if (!preferences.musicLoudnessLeveling) return 1;
    const info = key ? this.fadeCache.get(key) : undefined;
    return info ? levelFrom(info.gain) : 1;
  }

  /** Pose immédiatement le gain de la platine à son niveau nominal (hors fondu). */
  private applyDeckLevel(deck: Deck, key: string | null | undefined): void {
    if (!deck.gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    deck.gain.gain.cancelScheduledValues(now);
    deck.gain.gain.setTargetAtTime(this.levelFor(key), now, 0.08);
  }

  /**
   * Réglages d'enchaînement modifiés PENDANT l'écoute (panneau du lecteur) :
   * l'interaction est un geste utilisateur — le seul moment où l'on peut créer
   * le graphe si le fondu/nivellement vient d'être activé — et le nivellement
   * se ré-applique à la piste en cours sans attendre la suivante.
   */
  settingsChanged(): void {
    this.ensureGraph();
    const t = this.current;
    const d = this.decks[this.active];
    if (!t || !d) return;
    this.applyDeckLevel(d, t.key);
    if (preferences.musicLoudnessLeveling || preferences.musicSmartFades) {
      void this.fadeInfo(t.key).then(() => {
        if (this.current === t) this.applyDeckLevel(this.decks[this.active], t.key);
      });
    }
  }

  /** Analyse de sonie d'une piste, cachée (une requête par piste et par session). */
  private fadeInfo(key: string | null | undefined): Promise<TrackFadeInfo | null> {
    if (!key) return Promise.resolve(null);
    const hit = this.fadeCache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const inflight = this.fadeInflight.get(key);
    if (inflight) return inflight;
    const p = fetch(`/api/plex/fade/${key}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<TrackFadeInfo>) : null))
      .catch(() => null)
      .then((info) => {
        this.fadeCache.set(key, info);
        this.fadeInflight.delete(key);
        return info;
      });
    this.fadeInflight.set(key, p);
    return p;
  }

  // ─── Enchaînements (préchargement + fondu) ────────────────────────────────

  /** La piste qui suivra naturellement — null si fin de file (ou boucle sur soi). */
  private peekNext(): PlexTrack | null {
    if (this.repeat === 'one') return null;
    if (this.index + 1 < this.queue.length) return this.queue[this.index + 1];
    if (this.repeat === 'all' && this.queue.length > 1) return this.queue[0];
    return null;
  }

  /** À chaque timeupdate de la platine active : DJ, précharger, puis fondre. */
  private onTick(a: HTMLAudioElement): void {
    const dur = a.duration;
    if (!Number.isFinite(dur) || dur <= 0 || !this.playing) return;
    const remaining = dur - a.currentTime;
    const next = this.peekNext();
    if (!next) {
      this.maybeExtendDj(remaining);
      return;
    }
    if (this.captured && !this.fading && remaining <= PRELOAD_S) this.preloadNext(next);
    if (!this.canCrossfade()) return;
    const d = this.plannedFadeS(remaining);
    if (d !== null) this.startCrossfade(d, next);
  }

  /** Charge la piste suivante sur la platine libre (silencieuse tant que le fondu n'a pas commencé). */
  private preloadNext(next: PlexTrack): void {
    const other = this.otherDeck();
    if (!other || !next.part || this.preloadedKey === next.key) return;
    this.preloadedKey = next.key;
    if (other.gain && this.ctx) {
      other.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      other.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
    other.el.src = streamUrl(next.part);
    other.el.load();
    if (preferences.musicSmartFades || preferences.musicLoudnessLeveling) {
      void this.fadeInfo(this.current?.key);
      void this.fadeInfo(next.key);
    }
  }

  private canCrossfade(): boolean {
    return (
      this.captured &&
      !this.fading &&
      !this.wirelessOutput &&
      preferences.musicFadeSeconds > 0 &&
      (this.otherDeck()?.el.paused ?? false)
    );
  }

  /**
   * Durée de fondu à lancer MAINTENANT, ou null si ce n'est pas encore le
   * moment. Fondu intelligent : la durée suit le fade-out naturel de l'outro
   * (rampe PMS), bornée par le réglage — une fin sèche n'est pas amputée par
   * un fondu de 8 s, un long fade-out est couvert en entier.
   */
  private plannedFadeS(remaining: number): number | null {
    let d = preferences.musicFadeSeconds;
    if (preferences.musicSmartFades) {
      const info = this.current ? this.fadeCache.get(this.current.key) : undefined;
      if (info?.endRamp) d = Math.min(Math.max(outroLeadS(info.endRamp), MIN_SMART_FADE_S), d);
    }
    if (remaining > d + 0.2) return null;
    return Math.max(0.3, Math.min(d, remaining));
  }

  /**
   * Fondu enchaîné à puissance constante : la platine libre démarre (en
   * sautant l'éventuel silence d'intro) pendant que l'active s'éteint, et
   * DEVIENT la piste courante dès le début du fondu (convention PlexAmp).
   * Renvoie false si la platine libre n'est pas prête (on laissera `ended`
   * enchaîner classiquement).
   */
  private startCrossfade(d: number, next: PlexTrack): boolean {
    if (this.fading) return false;
    const out = this.decks[this.active];
    const inc = this.otherDeck();
    if (!inc?.gain || !out.gain || !this.ctx) return false;
    if (this.preloadedKey !== next.key || inc.el.readyState < 2) return false;
    this.fading = true;
    this.preloadedKey = null;
    const now = this.ctx.currentTime;
    const dur = Math.max(0.05, d);
    out.gain.gain.cancelScheduledValues(now);
    out.gain.gain.setValueCurveAtTime(
      equalPowerCurve('out', this.levelFor(this.current?.key)),
      now,
      dur
    );
    inc.gain.gain.cancelScheduledValues(now);
    inc.gain.gain.setValueCurveAtTime(equalPowerCurve('in', this.levelFor(next.key)), now, dur);
    // Silence de tête de l'entrante : on ne fond pas vers du vide.
    if (preferences.musicSmartFades) {
      const info = this.fadeCache.get(next.key);
      const lead = info?.startRamp ? introSilenceS(info.startRamp) : 0;
      if (lead > 0.7) {
        try {
          inc.el.currentTime = lead - 0.3;
        } catch {
          /* flux pas encore seekable : on part de 0 */
        }
      }
    }
    void inc.el.play().catch(() => undefined);
    // Bascule d'état : l'entrante est désormais la piste courante.
    this.active = 1 - this.active;
    this.index = this.index + 1 < this.queue.length ? this.index + 1 : 0;
    this.currentTime = inc.el.currentTime;
    this.duration =
      Number.isFinite(inc.el.duration) && inc.el.duration > 0
        ? inc.el.duration
        : (next.duration ?? 0) / 1000;
    this.lastError = null;
    this.syncMediaSessionMetadata(next);
    // Filet : si la sortante ne déclenche pas `ended` (fondu avant sa vraie fin),
    // on la coupe nous-mêmes. En arrière-plan iOS ce timer peut arriver en
    // retard — `ended` fait alors le ménage, les deux chemins sont idempotents.
    setTimeout(
      () => {
        if (!this.isActiveEl(out.el)) out.el.pause();
        this.fading = false;
      },
      (dur + 0.3) * 1000
    );
    return true;
  }

  // ─── DJ automatique (continuation de file, façon Auto Play PlexAmp) ───────

  /** Continuation DJ en cours de récupération (une seule à la fois). */
  private djInflight = false;
  /** Prochain essai DJ autorisé (timestamp ms) — pas de martèlement en panne. */
  private djRetryAt = 0;

  /**
   * La file touche à sa fin (dernière piste, pas de répétition) : le DJ
   * demande la suite à la station « Radio de la maison » du PMS (smart
   * shuffle pondéré par les écoutes — pas d'analyse sonique sur ce serveur)
   * et l'ajoute à la file. Déclenché à T−25 s pour que préchargement et
   * fondu enchaîné s'appliquent aussi au passage vers la sélection du DJ.
   */
  private maybeExtendDj(remaining: number): void {
    if (!preferences.musicAutoDj || this.repeat !== 'off') return;
    if (remaining > DJ_EXTEND_S) return;
    if (this.djInflight || Date.now() < this.djRetryAt) return;
    this.djInflight = true;
    void this.fetchDjTracks().then((fresh) => {
      this.djInflight = false;
      if (!fresh || fresh.length === 0) {
        this.djRetryAt = Date.now() + 60_000;
        return;
      }
      if (!preferences.musicAutoDj || this.queue.length === 0) return; // coupé/vidé entre-temps
      const lastIndex = this.queue.length - 1;
      this.queue = [...this.queue, ...fresh];
      // La piste s'est finie pendant la requête : on relance sur la suite du DJ.
      const a = this.decks[this.active]?.el;
      if (!this.playing && a?.ended && this.index === lastIndex) this.next();
    });
  }

  /** Fournée DJ : pistes de la station, sans doublon avec la file actuelle. */
  private async fetchDjTracks(): Promise<PlexTrack[] | null> {
    try {
      const res = await fetch(`/api/plex/station/${DJ_STATION_ID}?limit=${DJ_BATCH * 2}`, {
        cache: 'no-store'
      });
      if (!res.ok) return null;
      const { tracks } = (await res.json()) as { tracks: PlexTrack[] };
      const known = new Set(this.queue.map((t) => t.key));
      return tracks.filter((t) => t.part && !known.has(t.key)).slice(0, DJ_BATCH);
    } catch {
      return null;
    }
  }

  /** Coupe net un fondu (action manuelle pendant l'enchaînement). */
  private stopFadeHard(): void {
    const other = this.otherDeck();
    if (other) {
      other.el.pause();
      if (other.gain && this.ctx) {
        other.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        other.gain.gain.setValueAtTime(0, this.ctx.currentTime);
      }
    }
    const act = this.decks[this.active];
    if (act) this.applyDeckLevel(act, this.current?.key);
    this.fading = false;
    this.preloadedKey = null;
  }

  // ─── Destination de lecture (AirPlay / Remote Playback) ───────────────────

  /**
   * Safari (iOS/macOS) expose le sélecteur AirPlay natif sur l'élément audio
   * via webkitShowPlaybackTargetPicker ; les autres navigateurs passent par
   * l'API standard Remote Playback quand elle existe. Sans l'un ni l'autre,
   * le bouton « Sortie audio » du Now Playing n'est pas rendu.
   */
  private detectOutputPicker(a: HTMLAudioElement): void {
    const w = a as WebKitAudio;
    if (typeof w.webkitShowPlaybackTargetPicker === 'function') {
      this.outputPicker = 'airplay';
      a.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
        this.wirelessOutput = !!(a as WebKitAudio).webkitCurrentPlaybackTargetIsWireless;
      });
    } else if (a.remote && typeof a.remote.prompt === 'function') {
      this.outputPicker = 'remote';
      a.remote.addEventListener('connect', () => (this.wirelessOutput = true));
      a.remote.addEventListener('disconnect', () => (this.wirelessOutput = false));
    }
  }

  /** Ouvre le sélecteur natif de destination (bouton « Sortie audio »). */
  pickOutput(): void {
    const a = this.ensureAudio();
    const w = a as WebKitAudio;
    if (typeof w.webkitShowPlaybackTargetPicker === 'function') {
      w.webkitShowPlaybackTargetPicker();
    } else {
      a.remote?.prompt().catch(() => undefined);
    }
  }

  /** Lance une file de lecture (album, résultats…) à partir de `startIndex`. */
  play(tracks: PlexTrack[], startIndex = 0, context: string | null = null): void {
    const playable = tracks.filter((t) => t.part);
    if (playable.length === 0) return;
    let start = Math.max(
      0,
      playable.findIndex((t) => t.key === tracks[startIndex]?.key)
    );
    if (this.shuffle) {
      const chosen = playable[start];
      const rest = playable.filter((t) => t !== chosen);
      shuffleInPlace(rest);
      this.queue = [chosen, ...rest];
      start = 0;
    } else {
      this.queue = playable;
    }
    this.index = start;
    this.context = context;
    this.ensureGraph(); // geste utilisateur : le seul moment sûr pour créer le graphe
    this.load(true);
  }

  toggle(): void {
    const a = this.ensureAudio();
    if (!this.current) return;
    if (a.paused) {
      this.ensureGraph();
      if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      void a.play().catch(() => undefined);
    } else {
      if (this.fading) this.stopFadeHard();
      a.pause();
    }
  }

  next(): void {
    if (this.queue.length === 0) return;
    if (this.index + 1 < this.queue.length) {
      this.index += 1;
      this.load(true);
    } else if (this.repeat === 'all') {
      this.index = 0;
      this.load(true);
    }
  }

  prev(): void {
    const a = this.ensureAudio();
    // Convention iOS : < 3 s → piste précédente, sinon retour au début.
    if (a.currentTime > 3 || this.index === 0) {
      a.currentTime = 0;
      return;
    }
    this.index -= 1;
    this.load(true);
  }

  seek(seconds: number): void {
    const a = this.ensureAudio();
    a.currentTime = Math.max(0, Math.min(seconds, this.duration || seconds));
    this.currentTime = a.currentTime;
  }

  /** Ajoute des pistes à la FIN de la file (démarre la lecture si file vide). */
  enqueue(tracks: PlexTrack[]): void {
    const playable = tracks.filter((t) => t.part);
    if (playable.length === 0) return;
    if (this.queue.length === 0) {
      this.play(playable, 0, null);
      return;
    }
    this.queue = [...this.queue, ...playable];
  }

  /** Insère des pistes JUSTE APRÈS la piste courante (« Lire ensuite »). */
  playNext(tracks: PlexTrack[]): void {
    const playable = tracks.filter((t) => t.part);
    if (playable.length === 0) return;
    if (this.queue.length === 0) {
      this.play(playable, 0, null);
      return;
    }
    this.queue = [
      ...this.queue.slice(0, this.index + 1),
      ...playable,
      ...this.queue.slice(this.index + 1)
    ];
  }

  /** Saute à une piste précise de la file (liste « à suivre » du Now Playing). */
  jumpTo(i: number): void {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.ensureGraph();
    this.load(true);
  }

  /**
   * Retire une piste de la file (après suppression du fichier depuis le
   * lecteur). Si c'était la piste courante : on enchaîne sur la suivante (en ne
   * relançant la lecture que si on était en train de jouer) ; dernière piste →
   * retour au début de file, en pause ; file vide → lecteur fermé.
   */
  removeAt(i: number): void {
    if (i < 0 || i >= this.queue.length) return;
    const wasCurrent = i === this.index;
    const wasPlaying = this.playing;
    const q = this.queue.filter((_, idx) => idx !== i);
    if (q.length === 0) {
      this.clear();
      return;
    }
    this.queue = q;
    if (i < this.index) {
      this.index -= 1;
    } else if (wasCurrent) {
      if (this.index >= q.length) {
        this.index = 0;
        this.load(false);
      } else {
        this.load(wasPlaying);
      }
    }
  }

  toggleShuffle(): void {
    this.shuffle = !this.shuffle;
    if (this.shuffle && this.queue.length > 1) {
      // Mélange UNIQUEMENT la suite (la piste courante reste en place).
      const upcoming = this.queue.slice(this.index + 1);
      shuffleInPlace(upcoming);
      this.queue = [...this.queue.slice(0, this.index + 1), ...upcoming];
    }
  }

  cycleRepeat(): void {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
  }

  /** Vide la file (croix du mini-player quand lecture terminée). */
  clear(): void {
    for (const d of this.decks) {
      d.el.pause();
      d.el.src = '';
    }
    this.fading = false;
    this.preloadedKey = null;
    this.failStreak = 0;
    this.skipNotice = null;
    if (this.skipNoticeTimer) clearTimeout(this.skipNoticeTimer);
    this.queue = [];
    this.index = 0;
    this.playing = false;
    this.currentTime = 0;
    this.duration = 0;
    this.context = null;
    this.sheetOpen = false;
  }

  private autoNext(): void {
    if (this.repeat === 'one') {
      this.seek(0);
      void this.ensureAudio()
        .play()
        .catch(() => undefined);
      return;
    }
    // Platine libre déjà prête (fondu manqué en arrière-plan, piste très
    // courte…) : enchaînement immédiat quasi sans blanc plutôt qu'un
    // rechargement complet.
    const next = this.peekNext();
    if (next && this.captured && this.startCrossfade(0.05, next)) return;
    if (this.index + 1 < this.queue.length || this.repeat === 'all') this.next();
    else this.playing = false;
  }

  private load(autoplay: boolean): void {
    const t = this.current;
    if (!t?.part) return;
    const a = this.ensureAudio();
    this.stopFadeHard();
    this.lastError = null;
    this.currentTime = 0;
    this.duration = t.duration ? t.duration / 1000 : 0;
    a.src = streamUrl(t.part);
    if (this.captured) {
      this.applyDeckLevel(this.decks[this.active], t.key);
      if (preferences.musicLoudnessLeveling || preferences.musicSmartFades) {
        // Réchauffe l'analyse (nivellement dès que connue, rampes pour le fondu).
        void this.fadeInfo(t.key).then(() => {
          if (this.current === t) this.applyDeckLevel(this.decks[this.active], t.key);
        });
      }
    }
    if (autoplay) void a.play().catch(() => undefined);
    this.syncMediaSessionMetadata(t);
  }

  /**
   * Une piste refuse de se lire : diagnostic, puis la file CONTINUE — une piste
   * morte (effacée, abîmée, format inconnu) ne doit pas arrêter toute la
   * playlist. Garde-fous : session expirée = on s'arrête (sauter n'y changerait
   * rien, il faut se reconnecter) ; 3 échecs consécutifs = panne générale
   * (serveur, réseau), on n'égrène pas toute la file en rafale.
   */
  private async handlePlaybackError(a: HTMLAudioElement): Promise<void> {
    const failed = this.current;
    if (!failed) return; // src vidé par clear() : pas une piste en échec
    const { auth } = await this.diagnosePlaybackError(a);
    // Pendant le diagnostic (une requête), l'utilisateur a pu changer de piste
    // ou vider la file : la décision de sauter ne vaut que pour l'état capturé.
    if (this.current !== failed) return;
    if (auth) return;
    this.failStreak += 1;
    if (this.failStreak >= MAX_PLAYBACK_FAILURES) return;
    if (this.index + 1 >= this.queue.length && this.repeat !== 'all') return; // fin de file
    this.setSkipNotice(`« ${failed.title} » sauté — ${this.lastError ?? 'lecture impossible.'}`);
    this.lastError = null;
    this.next();
  }

  /** Affiche l'avis de saut quelques secondes (la lecture suit son cours). */
  private setSkipNotice(message: string): void {
    this.skipNotice = message;
    if (this.skipNoticeTimer) clearTimeout(this.skipNoticeTimer);
    this.skipNoticeTimer = setTimeout(() => (this.skipNotice = null), 8_000);
  }

  /**
   * Pourquoi la lecture a-t-elle échoué ?
   *
   * L'élément `<audio>` ne dit presque rien (`MediaError.code`), et le message
   * « format ou réseau » d'avant n'aidait personne : les causes réelles sont
   * très différentes et n'appellent pas la même action. On REJOUE donc la
   * requête sur le flux pour trancher — 2 octets suffisent.
   *
   * Le cas piégeux : session expirée. Le proxy répond alors par une
   * REDIRECTION vers /denied, et l'élément audio reçoit une page HTML au lieu
   * d'un fichier — il échoue exactement comme si le morceau n'existait pas.
   */
  private async diagnosePlaybackError(a: HTMLAudioElement): Promise<{ auth: boolean }> {
    const code = a.error?.code ?? 0;
    const byCode: Record<number, string> = {
      1: 'Lecture interrompue.',
      2: 'Réseau coupé pendant la lecture.',
      3: 'Fichier illisible (données abîmées).',
      4: 'Ce morceau n’a pas pu être lu.'
    };
    this.lastError = byCode[code] ?? 'Lecture impossible.';

    const src = a.currentSrc || a.src;
    if (!src) return { auth: false };
    try {
      const res = await fetch(src, {
        headers: { range: 'bytes=0-1' },
        redirect: 'manual', // ne PAS suivre : c'est la redirection qu'on cherche
        cache: 'no-store'
      });
      // `opaqueredirect` (status 0) : redirection non suivie = garde d'auth.
      if (res.type === 'opaqueredirect' || res.status === 302 || res.status === 303) {
        this.lastError = 'Session expirée — rechargez l’application pour vous reconnecter.';
        return { auth: true };
      } else if (res.status === 404) {
        this.lastError = 'Fichier introuvable sur le serveur Plex (déplacé ou supprimé).';
      } else if (res.status === 502 || res.status === 504) {
        this.lastError = 'Serveur Plex injoignable.';
      } else if (res.ok || res.status === 206) {
        // Le serveur sert bien le fichier : c'est le navigateur qui n'en veut pas.
        const type = res.headers.get('content-type') || 'type inconnu';
        this.lastError = `Format non lu par cet appareil (${type}).`;
      } else {
        this.lastError = `Lecture refusée par le serveur (HTTP ${res.status}).`;
      }
    } catch {
      this.lastError = 'Serveur injoignable (réseau).';
    }
    return { auth: false };
  }

  // ─── MediaSession (écran verrouillé / centre de contrôle iOS) ─────────────

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.toggle());
    ms.setActionHandler('pause', () => this.toggle());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    try {
      ms.setActionHandler('seekto', (d) => {
        if (d.seekTime != null) this.seek(d.seekTime);
      });
    } catch {
      /* seekto non supporté partout */
    }
  }

  private syncMediaSessionMetadata(t: PlexTrack): void {
    if (!('mediaSession' in navigator)) return;
    const art = plexImg(t.thumb, 512);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: art ? [{ src: new URL(art, location.origin).href, sizes: '512x512' }] : []
    });
  }

  private syncMediaSessionState(): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
  }
}

/** Une platine du lecteur : l'élément audio + son gain dans le graphe (si capturé). */
interface Deck {
  el: HTMLAudioElement;
  gain: GainNode | null;
}

/** Extensions WebKit (AirPlay) absentes de lib.dom. */
interface WebKitAudio extends HTMLAudioElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export const plex = new PlexState();
export const player = new PlayerState();
