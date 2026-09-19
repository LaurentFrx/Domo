/**
 * Dernier niveau d'encre VU de l'imprimante — mémorisé côté serveur.
 *
 * L'imprimante est le plus souvent hors tension (sa prise Zigbee est coupée) :
 * elle ne répond qu'aux rares moments où on l'allume. Sans mémoire serveur, la
 * carte n'avait que le cache du navigateur — 7 jours au plus, et Safari efface
 * de lui-même le stockage d'une PWA restée une semaine sans ouverture. Chaque
 * appareil repartait donc de « jamais jointe ».
 *
 * L'encre ne bouge QUE quand l'imprimante imprime, donc allumée et joignable :
 * le dernier relevé EST le niveau courant tant qu'elle ne répond pas. Il est
 * rendu tel quel, sans date ni mention de fraîcheur (demande de Laurent,
 * 19/09/2026). `seenAt` n'est gardé que pour le diagnostic.
 *
 * Stockage : `data/printer-inks.json` (relatif au WorkingDirectory, via
 * atomic-store : fsync + .bak). Écrit seulement quand un niveau CHANGE.
 */
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic, withFileLock } from './atomic-store';

export interface InkTank {
  color: 'BK' | 'C' | 'M' | 'Y';
  label: string;
  percent: number;
}

interface Stored {
  inks: InkTank[];
  seenAt: string | null;
}

const FILE = path.join(path.resolve(process.cwd(), 'data'), 'printer-inks.json');
const COLORS = new Set(['BK', 'C', 'M', 'Y']);

function normalize(raw: unknown): Stored {
  const o = (raw ?? {}) as Partial<Stored>;
  const inks = (Array.isArray(o.inks) ? o.inks : []).filter(
    (t): t is InkTank =>
      !!t &&
      COLORS.has((t as InkTank).color) &&
      typeof (t as InkTank).label === 'string' &&
      Number.isFinite((t as InkTank).percent)
  );
  return { inks, seenAt: typeof o.seenAt === 'string' ? o.seenAt : null };
}

// Mémoire de process : le fichier n'est lu qu'une fois, pas à chaque poll.
let cache: Stored | null = null;

export async function readLastInks(): Promise<InkTank[]> {
  cache ??= await readJsonSafe(FILE, {
    fallback: () => ({ inks: [], seenAt: null }),
    normalize,
    label: 'printer-inks.json'
  });
  return cache.inks;
}

/** Retient un relevé COMPLET (4 cuves). N'écrit sur disque que s'il diffère. */
export async function saveLastInks(inks: InkTank[]): Promise<void> {
  const prev = await readLastInks();
  const same =
    prev.length === inks.length &&
    prev.every((t, i) => t.color === inks[i].color && t.percent === inks[i].percent);
  if (same) return;
  const next: Stored = { inks, seenAt: new Date().toISOString() };
  await withFileLock(FILE, () => writeJsonAtomic(FILE, next));
  cache = next;
}
