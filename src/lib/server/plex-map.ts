/**
 * Mapping des métadonnées PMS (MediaContainer.Metadata) vers les formes compactes
 * servies au client par /api/plex/*, + conversion PlexError → erreur HTTP SvelteKit.
 */
import { error } from '@sveltejs/kit';
import { PlexError } from './plex';

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
  year?: number;
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
    thumb: md.thumb ?? md.parentThumb ?? md.grandparentThumb ?? null,
    part: md.Media?.[0]?.Part?.[0]?.key ?? null,
    codec: md.Media?.[0]?.audioCodec ?? null,
    bitrate: md.Media?.[0]?.bitrate ?? null,
    size: md.Media?.[0]?.Part?.[0]?.size ?? null,
    file: md.Media?.[0]?.Part?.[0]?.file ?? null
  };
}

/** Fichiers disque (vus du conteneur) d'un Metadata — pour la suppression. */
export function partFiles(md: RawMeta): string[] {
  return (md.Media ?? [])
    .flatMap((m) => m.Part ?? [])
    .map((p) => p.file)
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
}
