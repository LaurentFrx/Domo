/**
 * Exécution distante sur le RPi4 (tunnel réverse SSH 127.0.0.1:2222) pour les
 * opérations DISQUE de la bibliothèque musicale : dépôt de fichiers uploadés et
 * suppression de secours si l'API Plex refuse (allowMediaDeletion désactivé).
 *
 * Toujours `BatchMode` (clé uniquement, jamais d'interactif) et arguments passés
 * à execFile SANS shell local ; la commande distante est construite exclusivement
 * avec shellQuote() — aucun contenu utilisateur non quoté.
 */
import { execFile } from 'node:child_process';
import { PlexError, sshTarget } from './plex';

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];

function target(): { host: string; port: string } {
  const t = sshTarget();
  if (!t) throw new PlexError(503, 'PLEX_SSH_HOST / PLEX_HOST_MUSIC_PATH non configurés');
  return t;
}

/** Exécute `cmd` (déjà quotée via shellQuote) sur le RPi et renvoie stdout. */
export function sshExec(cmd: string, timeoutMs = 30_000): Promise<string> {
  const { host, port } = target();
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [...SSH_OPTS, '-p', port, host, cmd],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new PlexError(502, `SSH RPi: ${stderr.trim() || err.message}`));
        else resolve(stdout);
      }
    );
  });
}

/**
 * Écrit `data` dans `destPath` sur le RPi via stdin (pas de fichier temporaire
 * local). Écriture en `.part` puis `mv` — un upload interrompu ne laisse jamais
 * un fichier tronqué que Plex indexerait.
 */
export function sshWriteFile(
  destPath: string,
  data: Uint8Array,
  shellQuote: (s: string) => string,
  timeoutMs = 180_000
): Promise<void> {
  const { host, port } = target();
  const tmp = `${destPath}.part`;
  const cmd = `cat > ${shellQuote(tmp)} && mv -f ${shellQuote(tmp)} ${shellQuote(destPath)}`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      [...SSH_OPTS, '-p', port, host, cmd],
      { timeout: timeoutMs },
      (err, _stdout, stderr) => {
        if (err) reject(new PlexError(502, `SSH RPi (écriture): ${stderr.trim() || err.message}`));
        else resolve();
      }
    );
    child.stdin?.on('error', () => {
      /* EPIPE si ssh meurt : le callback execFile remonte déjà l'erreur */
    });
    child.stdin?.end(data);
  });
}
