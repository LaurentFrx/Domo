/**
 * Persistance serveur du planning d'Isabelle — fichier JSON local (modèle v2).
 *
 * GET/PUT /api/planning délègue ici. Stockage : `data/planning.json` (gitignored).
 * Le PUT REMPLACE le document après normalisation. Migration automatique depuis
 * l'ancien format v1 ({week: TimeSlot[][], exceptions}) → v2 « langage prof ».
 *
 * Le modèle « langage prof » (heure du 1er cours, semaine A/B…) vit dans
 * $lib/utils/planning-derive ; la dérivation de la chauffe se fait côté daemon.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonSafe, writeJsonAtomic } from './atomic-store';
import {
  defaultPlanningV2,
  defaultWeek,
  isHHMM,
  minToHHMM,
  toMin,
  type PlanningV2,
  type DayMorning,
  type WeekMornings,
  type PlanningException,
  type ActivityType,
  type EveningShower,
  type AssistantPeriod
} from '$lib/utils/planning-derive';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'planning.json');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES: ActivityType[] = ['cours', 'reunion', 'conseil', 'aide', 'autre'];

const asType = (t: unknown): ActivityType =>
  typeof t === 'string' && (TYPES as string[]).includes(t) ? (t as ActivityType) : 'autre';
const asHHMM = (v: unknown, d: string): string => (isHHMM(v) ? (v as string) : d);
const asInt = (v: unknown, d: number): number =>
  typeof v === 'number' && isFinite(v) ? Math.round(v) : d;
const isISODate = (v: unknown): v is string => typeof v === 'string' && ISO_DATE.test(v);

function normDayMorning(v: unknown): DayMorning {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.kind === 'start' && isHHMM(o.start)) {
      return o.halfGroup === true
        ? { kind: 'start', start: o.start as string, halfGroup: true }
        : { kind: 'start', start: o.start as string };
    }
    if (o.kind === 'afternoon') return { kind: 'afternoon' };
    if (o.kind === 'rest') return { kind: 'rest' };
    if (o.kind === 'inherit') return { kind: 'inherit' };
  }
  return { kind: 'inherit' };
}

function normWeek(v: unknown): WeekMornings {
  const arr = Array.isArray(v) ? v : [];
  return defaultWeek().map((def, i) => (i < arr.length ? normDayMorning(arr[i]) : def));
}

function normException(v: unknown): PlanningException | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isISODate(o.date)) return null;
  const affects = o.affectsMorning === true;
  const exc: PlanningException = {
    id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
    date: o.date,
    type: asType(o.type),
    affectsMorning: affects
  };
  if (typeof o.label === 'string' && o.label) exc.label = o.label;
  if (affects) {
    const m = o.morning as Record<string, unknown> | undefined;
    exc.morning =
      m && m.kind === 'start' && isHHMM(m.start)
        ? { kind: 'start', start: m.start as string }
        : { kind: 'rest' };
  } else if (isHHMM(o.time)) {
    exc.time = o.time as string;
  }
  return exc;
}

function normEvening(v: unknown): EveningShower {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const days = Array.isArray(o.days)
    ? (o.days.filter((d) => typeof d === 'number' && d >= 0 && d <= 6) as number[])
    : [0, 1, 2, 3, 4];
  return { enabled: o.enabled === true, targetReady: asHHMM(o.targetReady, '19:30'), days };
}

function normAssistant(v: unknown): AssistantPeriod | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isISODate(o.from) || !isISODate(o.to)) return null;
  const p: AssistantPeriod = {
    id: typeof o.id === 'string' && o.id ? o.id : randomUUID(),
    from: o.from,
    to: o.to
  };
  if (typeof o.label === 'string' && o.label) p.label = o.label;
  return p;
}

/** Migration v1 ({week: TimeSlot[][], exceptions}) → v2. Mapping lossy assumé :
 *  un jour multi-créneaux → heure de début la plus tôt ; jour vide → « comme
 *  d'habitude » (inherit) pour ne pas couper la chauffe par erreur. */
function migrateV1(o: Record<string, unknown>): PlanningV2 {
  const base = defaultPlanningV2();
  const week = Array.isArray(o.week) ? o.week : [];
  const starts: number[] = [];
  base.weekA = defaultWeek().map((def, i) => {
    const slots = Array.isArray(week[i]) ? (week[i] as Array<{ start?: unknown }>) : [];
    const valid = slots
      .map((s) => (s && isHHMM(s.start) ? (s.start as string) : null))
      .filter((x): x is string => x !== null)
      .sort();
    if (valid.length === 0) return def;
    starts.push(toMin(valid[0]));
    return { kind: 'start', start: valid[0] };
  });
  if (starts.length) base.defaultStart = minToHHMM(Math.min(...starts));
  const exV1 = Array.isArray(o.exceptions) ? o.exceptions : [];
  base.exceptions = exV1
    .map((e): PlanningException | null => {
      const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
      if (!isISODate(x.date)) return null;
      const slots = Array.isArray(x.slots) ? (x.slots as Array<{ start?: unknown }>) : [];
      const valid = slots
        .map((s) => (s && isHHMM(s.start) ? (s.start as string) : null))
        .filter((y): y is string => y !== null)
        .sort();
      return {
        id: randomUUID(),
        date: x.date,
        type: 'autre',
        affectsMorning: true,
        morning: valid.length ? { kind: 'start', start: valid[0] } : { kind: 'rest' }
      };
    })
    .filter((x): x is PlanningException => x !== null);
  return base;
}

export function normalizePlanning(raw: unknown): PlanningV2 {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (o.version !== 2) {
    if (Array.isArray(o.week) || Array.isArray(o.exceptions)) return migrateV1(o);
    return defaultPlanningV2();
  }
  const base = defaultPlanningV2();
  const comfort = (o.comfort && typeof o.comfort === 'object' ? o.comfort : {}) as Record<
    string,
    unknown
  >;
  return {
    version: 2,
    defaultStart: asHHMM(o.defaultStart, base.defaultStart),
    abEnabled: o.abEnabled === true,
    abAnchorMonday: isISODate(o.abAnchorMonday) ? o.abAnchorMonday : base.abAnchorMonday,
    abAnchorIsA: o.abAnchorIsA !== false,
    weekA: normWeek(o.weekA),
    weekB: normWeek(o.weekB),
    comfort: {
      wakeBeforeFirstMin: asInt(comfort.wakeBeforeFirstMin, base.comfort.wakeBeforeFirstMin),
      departBeforeFirstMin: asInt(comfort.departBeforeFirstMin, base.comfort.departBeforeFirstMin)
    },
    eveningShower: normEvening(o.eveningShower),
    exceptions: (Array.isArray(o.exceptions) ? o.exceptions : [])
      .map(normException)
      .filter((x): x is PlanningException => x !== null)
      .sort((a, b) => a.date.localeCompare(b.date)),
    assistantPeriods: (Array.isArray(o.assistantPeriods) ? o.assistantPeriods : [])
      .map(normAssistant)
      .filter((x): x is AssistantPeriod => x !== null)
  };
}

export async function readPlanning(): Promise<PlanningV2> {
  return readJsonSafe(FILE, {
    fallback: defaultPlanningV2,
    normalize: normalizePlanning,
    label: 'planning.json'
  });
}

export async function writePlanning(data: PlanningV2): Promise<PlanningV2> {
  const clean = normalizePlanning(data);
  await writeJsonAtomic(FILE, clean);
  return clean;
}
