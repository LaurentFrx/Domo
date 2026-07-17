/**
 * Store Plex (musique) — bibliothèque + LECTEUR audio global « PlexAmp maison ».
 *
 * Deux singletons :
 *   - `plex`   : état de l'intégration (appairage plex.tv/link), bibliothèque
 *                (récents, albums paginés, artistes, recherche) et gestion
 *                (upload, suppression, scan). Cycle de vie refcounté (acquire).
 *   - `player` : file de lecture + HTMLAudioElement MODULE-LEVEL (jamais monté
 *                dans le DOM) → la musique survit aux swipes du pager et aux
 *                navigations. MediaSession pour l'écran verrouillé iOS.
 *
 * Pas de polling continu : la bibliothèque est statique, on (re)charge à la
 * demande + au retour de visibilité si l'état n'était pas prêt. Le token Plex
 * ne transite JAMAIS ici : tout passe par le proxy authentifié /api/plex/*.
 */

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

/** Mix intelligents « une touche » (façon PlexAmp) — lecture immédiate. */
export const SMART_PRESETS: SmartPreset[] = [
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
  },
  {
    id: 'inexplores',
    label: 'Jamais écoutés',
    desc: 'Les terres inconnues de la bibliothèque',
    hue: 350,
    rules: { neverPlayed: true, sort: 'random', limit: 100 }
  }
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
   * Upload de fichiers audio avec progression (XMLHttpRequest — fetch n'expose
   * pas la progression d'envoi). Résout avec les noms enregistrés.
   */
  upload(files: File[]): Promise<string[]> {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    this.uploadProgress = 0;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/plex/upload');
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) this.uploadProgress = ev.loaded / ev.total;
      };
      xhr.onload = () => {
        this.uploadProgress = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          const j = JSON.parse(xhr.responseText) as { saved: string[] };
          // Les nouveautés apparaîtront dans « récents » après le scan.
          setTimeout(() => void this.reloadQuiet(), 4_000);
          resolve(j.saved);
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
      xhr.onerror = () => {
        this.uploadProgress = null;
        reject(new Error('Envoi interrompu'));
      };
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
  /** Feuille « Now Playing » plein écran ouverte ? (UI globale) */
  sheetOpen = $state(false);
  /** Sélecteur de destination dispo ('airplay' WebKit iOS/macOS, 'remote' ailleurs). */
  outputPicker = $state<'airplay' | 'remote' | null>(null);
  /** Lecture envoyée vers un appareil sans fil (AirPlay, Cast…) ? */
  wirelessOutput = $state(false);

  current = $derived<PlexTrack | null>(this.queue[this.index] ?? null);

  private audio: HTMLAudioElement | null = null;

  /** Élément audio paresseux + écouteurs (client uniquement). */
  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('timeupdate', () => (this.currentTime = a.currentTime));
    a.addEventListener('durationchange', () => (this.duration = a.duration || 0));
    a.addEventListener('play', () => {
      this.playing = true;
      this.syncMediaSessionState();
    });
    a.addEventListener('pause', () => {
      this.playing = false;
      this.syncMediaSessionState();
    });
    a.addEventListener('ended', () => this.autoNext());
    a.addEventListener('error', () => {
      this.lastError = 'Lecture impossible (format ou réseau)';
      this.playing = false;
    });
    this.detectOutputPicker(a);
    this.audio = a;
    this.setupMediaSession();
    return a;
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
    this.load(true);
  }

  toggle(): void {
    const a = this.ensureAudio();
    if (!this.current) return;
    if (a.paused) void a.play().catch(() => undefined);
    else a.pause();
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
    this.audio?.pause();
    if (this.audio) this.audio.src = '';
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
    if (this.index + 1 < this.queue.length || this.repeat === 'all') this.next();
    else this.playing = false;
  }

  private load(autoplay: boolean): void {
    const t = this.current;
    if (!t?.part) return;
    const a = this.ensureAudio();
    this.lastError = null;
    this.currentTime = 0;
    this.duration = t.duration ? t.duration / 1000 : 0;
    a.src = streamUrl(t.part);
    if (autoplay) void a.play().catch(() => undefined);
    this.syncMediaSessionMetadata(t);
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
