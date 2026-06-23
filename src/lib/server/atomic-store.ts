/**
 * Écriture/lecture atomiques ET DURABLES des fichiers d'état JSON (`data/*.json`).
 *
 * Pourquoi ce module : `writeFile(tmp)` + `rename()` protège du crash applicatif
 * (atomicité logique : un lecteur voit l'ancien OU le nouveau) MAIS PAS d'une
 * coupure de courant. Sans `fsync`, `writeFile` n'écrit que dans le page cache du
 * noyau ; après une coupure secteur, le `rename` (journalisé) peut survivre alors
 * que les blocs du fichier sont encore vides → fichier de 0 octet ou tronqué au
 * reboot, et perte silencieuse des réglages malgré un PUT « réussi ».
 *
 * Garanties ici :
 *   ÉCRITURE  write(tmp) → fsync(tmp) → copie .bak (version N-1) → rename → fsync(dir)
 *   LECTURE   ENOENT → défaut (normal) ; CORROMPU → quarantaine `.corrupt-<ts>` +
 *             restauration automatique depuis `.bak` + incident CRITIQUE.
 *             Jamais un défaut muet qui écraserait ensuite la vraie donnée.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Remontée d'incident DÉCOUPLÉE (injectée par l'app au démarrage via
// setIncidentReporter) : garde ce module sans dépendance → testable isolément.
type RaiseFn = (i: {
  key: string;
  severity: 'critical' | 'warning' | 'info';
  source: string;
  kind: string;
  message: string;
}) => void;
type ResolveFn = (key: string, repaired?: string) => void;
let reportIncident: RaiseFn = () => {};
let clearIncident: ResolveFn = () => {};
export function setIncidentReporter(raise: RaiseFn, resolve: ResolveFn): void {
  reportIncident = raise;
  clearIncident = resolve;
}

/** Écrit `value` en JSON de façon atomique et durable (résiste à la coupure de courant). */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(value, null, 2);

  // 1) écrire le tmp ET le fsync : force les blocs sur le disque, pas seulement le cache.
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(json, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }

  // 2) conserver la version N-1 en .bak (best-effort) AVANT d'écraser le fichier.
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error(`[atomic-store] backup ${path.basename(file)} échoué: ${(e as Error).message}`);
  }

  // 3) rename atomique : bascule instantanée vers la nouvelle version.
  await fs.rename(tmp, file);

  // 4) fsync du répertoire : durcit l'entrée de répertoire (best-effort selon le FS).
  try {
    const dh = await fs.open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* FS sans fsync de répertoire (rare) : best-effort */
  }
}

const fileLocks = new Map<string, Promise<unknown>>();

/**
 * Sérialise les sections critiques (read-modify-write) par fichier. Empêche deux
 * requêtes concurrentes de s'entrelacer sur leurs `await` et de se perdre l'une
 * l'autre (lost update) — ex. un PUT réglages et un PUT config cumulus qui
 * écrivent tous deux settings.json.
 */
export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn); // exécute fn que la précédente ait réussi ou non
  fileLocks.set(
    file,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

async function quarantine(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* déjà absent / non renommable : on ignore */
  }
}

export interface ReadOpts<T> {
  /** Valeur de repli (DB neuve / fichier jamais créé). */
  fallback: () => T;
  /** Validation/normalisation défensive du contenu lu. */
  normalize?: (raw: unknown) => T;
  /** Libellé lisible pour logs/incidents (par défaut : nom de fichier). */
  label?: string;
}

/**
 * Lit un JSON en se défendant contre la corruption. ENOENT → `fallback` (normal,
 * silencieux). Fichier présent mais illisible → quarantaine + restauration depuis
 * `.bak` si possible + incident CRITIQUE. Ne renvoie JAMAIS un défaut muet.
 */
export async function readJsonSafe<T>(file: string, opts: ReadOpts<T>): Promise<T> {
  const norm = opts.normalize ?? ((r: unknown) => r as T);
  const label = opts.label ?? path.basename(file);
  try {
    const value = norm(JSON.parse(await fs.readFile(file, 'utf-8')));
    clearIncident(`corrupt:${label}`, 'fichier relu avec succès');
    return value;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return opts.fallback(); // jamais créé → défaut légitime

    // Présent mais illisible/corrompu. On NE retourne PAS un défaut muet (le
    // prochain write l'écraserait définitivement). On tente .bak, sinon défaut,
    // mais en CRIANT (log + incident critique) pour que l'alerte se déclenche.
    try {
      const value = norm(JSON.parse(await fs.readFile(`${file}.bak`, 'utf-8')));
      await quarantine(file); // écarte le corrompu pour post-mortem
      await fs.copyFile(`${file}.bak`, file).catch(() => {}); // ré-établit le fichier principal
      reportIncident({
        key: `corrupt:${label}`,
        severity: 'critical',
        source: label,
        kind: 'corrupt',
        message: `${label} corrompu — restauré automatiquement depuis la sauvegarde (.bak)`
      });
      console.error(`[atomic-store] ${label} corrompu → restauré depuis .bak`);
      return value;
    } catch {
      await quarantine(file);
      reportIncident({
        key: `corrupt:${label}`,
        severity: 'critical',
        source: label,
        kind: 'corrupt',
        message: `${label} corrompu et aucune sauvegarde exploitable — repli sur l'état par défaut`
      });
      console.error(`[atomic-store] ${label} corrompu, pas de .bak → état par défaut`);
      return opts.fallback();
    }
  }
}
