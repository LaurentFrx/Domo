/**
 * Persistance serveur du planning d'occupation (Isabelle) — fichier JSON local.
 *
 * Le client appelle GET/PUT /api/planning, qui délègue ici.
 * Stockage : `data/planning.json` à la racine du projet (gitignored, comme
 * settings.json). Contrairement aux settings, le PUT REMPLACE le document
 * (structure fixe), après normalisation/validation.
 *
 * Modèle : `week` = 7 jours (index 0 = lundi … 6 = dimanche), chaque jour une
 * liste de créneaux d'occupation { start, end } au format "HH:MM" ; `exceptions`
 * = dates précises (YYYY-MM-DD) qui surchargent la semaine type ce jour-là.
 * Ce planning alimente le moteur de créneaux de confort du daemon thermostat.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'planning.json');

export type TimeSlot = { start: string; end: string };
export type PlanningException = { date: string; slots: TimeSlot[] };
export type PlanningJson = { week: TimeSlot[][]; exceptions: PlanningException[] };

const emptyWeek = (): TimeSlot[][] => [[], [], [], [], [], [], []];
const EMPTY: PlanningJson = { week: emptyWeek(), exceptions: [] };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanSlot(s: unknown): TimeSlot | null {
  if (!s || typeof s !== 'object') return null;
  const { start, end } = s as Record<string, unknown>;
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  if (!HHMM.test(start) || !HHMM.test(end)) return null;
  return { start, end };
}

function cleanSlots(arr: unknown): TimeSlot[] {
  return Array.isArray(arr) ? arr.map(cleanSlot).filter((x): x is TimeSlot => x !== null) : [];
}

/** Normalise un JSON arbitraire vers la forme attendue (7 jours, créneaux valides). */
export function normalizePlanning(raw: unknown): PlanningJson {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const wkRaw = Array.isArray(obj.week) ? obj.week : [];
  const week = emptyWeek().map((_, i) => cleanSlots(wkRaw[i]));
  const exRaw = Array.isArray(obj.exceptions) ? obj.exceptions : [];
  const exceptions: PlanningException[] = exRaw
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      const date = typeof o.date === 'string' ? o.date : '';
      if (!ISO_DATE.test(date)) return null;
      return { date, slots: cleanSlots(o.slots) };
    })
    .filter((x): x is PlanningException => x !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { week, exceptions };
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readPlanning(): Promise<PlanningJson> {
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    return normalizePlanning(JSON.parse(raw));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw e;
  }
}

export async function writePlanning(data: PlanningJson): Promise<PlanningJson> {
  await ensureDataDir();
  const clean = normalizePlanning(data);
  // Écriture atomique : tmp + rename pour éviter un fichier corrompu en cas de
  // crash en plein write.
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf-8');
  await fs.rename(tmp, FILE);
  return clean;
}
