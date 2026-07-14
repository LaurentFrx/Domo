/**
 * POST /api/plex/upload — ajout de musique à la bibliothèque (multipart, champ
 * `files`, plusieurs fichiers). Chaque fichier est déposé dans
 * `<musique>/Ajouts Domo/` sur le disque du RPi4 via SSH (stdin → cat, écriture
 * .part puis mv : jamais de fichier tronqué indexé), puis un scan PARTIEL du
 * dossier d'ajouts est déclenché — les morceaux apparaissent en « récents ».
 *
 * ⚠️ La taille acceptée dépend de BODY_SIZE_LIMIT (.env, adapter-node).
 */
import { error, json } from '@sveltejs/kit';
import { musicSection, pmsFetch, shellQuote, sshTarget, PlexError } from '$lib/server/plex';
import { plexHttp } from '$lib/server/plex-map';
import { sshWriteFile } from '$lib/server/plex-ssh';
import type { RequestHandler } from './$types';

const AUDIO_RE = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|aif|aiff)$/i;
const UPLOAD_DIR = 'Ajouts Domo';

/** Nom de fichier sûr pour exFAT : pas de séparateurs ni de caractères réservés. */
function sanitizeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base
    .replace(/[\u0000-\u001f:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  if (!clean || !AUDIO_RE.test(clean)) {
    throw error(415, `Fichier non géré : « ${base} » (formats : mp3, m4a, flac, ogg, wav…)`);
  }
  return clean;
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

  try {
    const saved: string[] = [];
    for (const f of files) {
      const name = sanitizeName(f.name);
      const data = new Uint8Array(await f.arrayBuffer());
      await sshWriteFile(`${ssh.musicRoot}/${UPLOAD_DIR}/${name}`, data, shellQuote);
      saved.push(name);
    }

    // Scan partiel du dossier d'ajouts (chemin VU PAR LE CONTENEUR Plex).
    const section = await musicSection();
    const containerRoot = section.locations[0];
    if (containerRoot) {
      const res = await pmsFetch(
        `/library/sections/${section.key}/refresh?path=${encodeURIComponent(`${containerRoot}/${UPLOAD_DIR}`)}`
      );
      if (!res.ok) throw new PlexError(502, `Scan Plex: HTTP ${res.status}`);
    }
    return json({ ok: true, saved });
  } catch (e) {
    plexHttp(e);
  }
};
