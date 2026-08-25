/**
 * POST /api/plex/upload — ajout de musique à la bibliothèque (multipart, champs
 * `files` + `paths` alignés : un chemin relatif par fichier). Chaque fichier est
 * déposé sous `<musique>/Ajouts Domo/` sur le disque du RPi4 via SSH (stdin →
 * cat, écriture .part puis mv : jamais de fichier tronqué indexé), en respectant
 * les sous-dossiers (un album acheté = un dossier, pochettes comprises). Les
 * fichiers ni audio ni image (livret PDF, .url…) sont ignorés sans faire échouer
 * l'envoi. Un scan PARTIEL du dossier d'ajouts est ensuite déclenché — les
 * morceaux apparaissent en « récents ».
 *
 * ⚠️ La taille acceptée par requête dépend de BODY_SIZE_LIMIT (.env,
 * adapter-node) — le client découpe l'envoi en lots pour rester dessous.
 */
import { error, json } from '@sveltejs/kit';
import { musicSection, pmsFetch, shellQuote, sshTarget, PlexError } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import { sshExec, sshWriteFile } from '$lib/server/plex-ssh';
import type { RequestHandler } from './$types';

const AUDIO_RE = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|aif|aiff)$/i;
/** Pochettes et livrets image : embarqués pour que Plex habille l'album. */
const IMAGE_RE = /\.(jpe?g|png|webp|gif)$/i;
const UPLOAD_DIR = 'Ajouts Domo';
/** Profondeur max sous « Ajouts Domo » (Artiste/Album/CD1 suffit largement). */
const MAX_DIR_DEPTH = 3;

/** Segment de chemin sûr pour exFAT : pas de séparateurs, de réservés ni de `..`. */
function cleanSegment(seg: string): string | null {
  // eslint-disable-next-line no-control-regex
  const clean = seg
    .replace(/[\u0000-\u001f:*?"<>|\\/]/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180);
  return clean || null;
}

/**
 * Nettoie un chemin relatif (séparateurs Windows compris) et le classe.
 * Renvoie null si le fichier doit être ignoré (type non géré, chemin invalide).
 */
function sanitizeRelPath(raw: string): string | null {
  const parts = raw.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_DIR_DEPTH + 1) return null;
  const cleaned: string[] = [];
  for (const p of parts) {
    const c = cleanSegment(p);
    if (!c) return null;
    cleaned.push(c);
  }
  const name = cleaned[cleaned.length - 1];
  if (!AUDIO_RE.test(name) && !IMAGE_RE.test(name)) return null;
  return cleaned.join('/');
}

export const POST: RequestHandler = async ({ request }) => {
  const ssh = sshTarget();
  if (!ssh) throw error(503, 'PLEX_SSH_HOST / PLEX_HOST_MUSIC_PATH non configurés');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw error(400, 'Corps multipart invalide (fichier trop gros ?)');
  }
  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) throw error(400, 'Aucun fichier reçu');
  // `paths` aligné sur `files` ; à défaut (ancien client), le nom du fichier.
  const paths = form.getAll('paths').map(String);

  const kept: { file: File; rel: string }[] = [];
  const skipped: string[] = [];
  files.forEach((f, i) => {
    const raw = paths[i] || f.name;
    const rel = sanitizeRelPath(raw);
    if (rel) kept.push({ file: f, rel });
    else skipped.push(raw.split(/[\\/]/).pop() || raw);
  });
  if (!kept.some(({ rel }) => AUDIO_RE.test(rel))) {
    throw error(415, 'Aucun fichier audio dans la sélection (formats : mp3, m4a, flac, ogg, wav…)');
  }

  try {
    // Dossiers cibles créés en une seule commande (racine d'ajouts comprise).
    const dirs = new Set([`${ssh.musicRoot}/${UPLOAD_DIR}`]);
    for (const { rel } of kept) {
      const cut = rel.lastIndexOf('/');
      if (cut > 0) dirs.add(`${ssh.musicRoot}/${UPLOAD_DIR}/${rel.slice(0, cut)}`);
    }
    await sshExec(`mkdir -p ${[...dirs].map(shellQuote).join(' ')}`);

    const saved: string[] = [];
    for (const { file, rel } of kept) {
      const data = new Uint8Array(await file.arrayBuffer());
      await sshWriteFile(`${ssh.musicRoot}/${UPLOAD_DIR}/${rel}`, data, shellQuote);
      saved.push(rel);
    }

    // Scan partiel du dossier d'ajouts (chemin VU PAR LE CONTENEUR Plex) — il
    // est récursif, les sous-dossiers d'albums sont indexés avec.
    const section = await musicSection();
    const containerRoot = section.locations[0];
    if (containerRoot) {
      const res = await pmsFetch(
        `/library/sections/${section.key}/refresh?path=${encodeURIComponent(`${containerRoot}/${UPLOAD_DIR}`)}`
      );
      if (!res.ok) throw new PlexError(502, `Scan Plex: HTTP ${res.status}`);
    }
    return json({ ok: true, saved, skipped });
  } catch (e) {
    plexHttp(e);
  }
};
