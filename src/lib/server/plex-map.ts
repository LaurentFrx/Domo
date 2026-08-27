/**
 * Mapping des métadonnées PMS (MediaContainer.Metadata) vers les formes compactes
 * servies au client par /api/plex/*, + conversion PlexError → erreur HTTP SvelteKit.
 */
import { error } from '@sveltejs/kit';
import { PlexError } from './plex';
import { signStreamPart } from './stream-sign';

/** À utiliser dans les catch des routes : convertit PlexError, relaie le reste. */
export function plexHttp(e: unknown): never {
  if (e instanceof PlexError) throw error(e.status, e.message);
  throw e;
}

/** Sous-ensemble utile d'un Metadata PMS (champs optionnels selon le type). */
export interface RawMeta {
  ratingKey?: string | number;
  type?: string;
  title?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  originalTitle?: string;
  parentRatingKey?: string | number;
  grandparentRatingKey?: string | number;
  year?: number;
  parentYear?: number;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  addedAt?: number;
  leafCount?: number;
  childCount?: number;
  index?: number;
  parentIndex?: number;
  duration?: number;
  Media?: Array<{
    audioCodec?: string;
    bitrate?: number;
    Part?: Array<{ key?: string; file?: string; size?: number }>;
  }>;
  /* Playlists */
  playlistType?: string;
  smart?: boolean | number | string;
  composite?: string;
  playlistItemID?: number;
}

export interface AlbumJson {
  key: string;
  title: string;
  artist: string;
  artistKey: string | null;
  year: number | null;
  thumb: string | null;
  tracks: number | null;
}

export interface ArtistJson {
  key: string;
  title: string;
  thumb: string | null;
  albums: number | null;
}

export interface TrackJson {
  key: string;
  title: string;
  index: number | null;
  disc: number | null;
  /** Durée en ms (convention PMS). */
  duration: number | null;
  artist: string;
  album: string;
  albumKey: string | null;
  /** Clé de l'ARTISTE d'album (grandparent) — les DJ « même artiste ». */
  artistKey: string | null;
  /** Année de l'album (parentYear) — le DJ « même époque ». */
  year: number | null;
  thumb: string | null;
  /** Chemin de la partie média (/library/parts/…/file.ext) pour le stream. */
  part: string | null;
  /** Infos techniques du fichier (pop-up « infos du morceau »). */
  codec: string | null;
  /** kbps (convention PMS). */
  bitrate: number | null;
  /** Octets. */
  size: number | null;
  /** Chemin disque VU PAR LE CONTENEUR Plex (info, jamais utilisé côté client). */
  file: string | null;
  /** Identifiant de LIGNE dans une playlist (retrait/déplacement) — null hors playlist. */
  playlistItemId: number | null;
}

export interface PlaylistJson {
  key: string;
  title: string;
  /** Playlist intelligente Plex (se met à jour seule, non éditable à la main). */
  smart: boolean;
  count: number | null;
  /** Durée totale en ms. */
  duration: number | null;
  /** Chemin de la mosaïque de pochettes (/playlists/N/composite/N). */
  thumb: string | null;
}

export function mapPlaylist(md: RawMeta): PlaylistJson {
  return {
    key: String(md.ratingKey ?? ''),
    title: md.title ?? '?',
    smart: md.smart === true || md.smart === 1 || md.smart === '1',
    count: md.leafCount ?? null,
    duration: md.duration ?? null,
    thumb: md.composite ?? null
  };
}

export function mapAlbum(md: RawMeta): AlbumJson {
  return {
    key: String(md.ratingKey ?? ''),
    title: md.title ?? '?',
    artist: md.parentTitle ?? '',
    artistKey: md.parentRatingKey != null ? String(md.parentRatingKey) : null,
    year: md.year ?? null,
    thumb: md.thumb ?? null,
    tracks: md.leafCount ?? null
  };
}

export function mapArtist(md: RawMeta): ArtistJson {
  return {
    key: String(md.ratingKey ?? ''),
    title: md.title ?? '?',
    thumb: md.thumb ?? null,
    albums: md.childCount ?? null
  };
}

export function mapTrack(md: RawMeta): TrackJson {
  return {
    key: String(md.ratingKey ?? ''),
    title: md.title ?? '?',
    index: md.index ?? null,
    disc: md.parentIndex ?? null,
    duration: md.duration ?? null,
    // originalTitle = artiste de la PISTE quand il diffère de l'artiste d'album
    // (compilations « Artistes divers ») — prioritaire sur grandparentTitle.
    artist: md.originalTitle ?? md.grandparentTitle ?? '',
    album: md.parentTitle ?? '',
    albumKey: md.parentRatingKey != null ? String(md.parentRatingKey) : null,
    artistKey: md.grandparentRatingKey != null ? String(md.grandparentRatingKey) : null,
    year: md.parentYear ?? null,
    thumb: md.thumb ?? md.parentThumb ?? md.grandparentThumb ?? null,
    // Signée : une enceinte AirPlay vient chercher le flux SANS cookie.
    part: md.Media?.[0]?.Part?.[0]?.key ? signStreamPart(md.Media[0].Part[0].key!) : null,
    codec: md.Media?.[0]?.audioCodec ?? null,
    bitrate: md.Media?.[0]?.bitrate ?? null,
    size: md.Media?.[0]?.Part?.[0]?.size ?? null,
    file: md.Media?.[0]?.Part?.[0]?.file ?? null,
    playlistItemId: md.playlistItemID ?? null
  };
}

/** Fichiers disque (vus du conteneur) d'un Metadata — pour la suppression. */
export function partFiles(md: RawMeta): string[] {
  return (md.Media ?? [])
    .flatMap((m) => m.Part ?? [])
    .map((p) => p.file)
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
}
