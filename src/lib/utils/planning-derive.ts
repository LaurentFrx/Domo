/**
 * planning-derive — modèle « langage prof » du planning d'Isabelle (v2) + helpers
 * PURS partagés entre le front (affichage, store) et, en miroir, le daemon Python
 * (exécution, source de vérité du chauffage).
 *
 * Principe : ce modèle ne stocke AUCUNE heure de chauffe. On ne saisit que l'heure
 * du PREMIER cours par jour ; la chauffe matinale est dérivée = 1er cours − réveil
 * (défaut 1h30) − préchauffe. Voir docs/chauffage-sdb.md.
 */

export type HHMM = string; // "08:00"
export type ISODate = string; // "2026-03-12"

/** Type d'activité — informatif pour Isabelle ; seul le matin pilote la chauffe. */
export type ActivityType = 'cours' | 'reunion' | 'conseil' | 'aide' | 'autre';

/** État du matin d'un jour de la semaine type (une seule heure : le 1er cours). */
export type DayMorning =
  | { kind: 'inherit' } // suit le rythme habituel (defaultStart)
  | { kind: 'start'; start: HHMM; halfGroup?: boolean } // je commence à HH:MM
  | { kind: 'afternoon' } // pas le matin → pas de chauffe matin
  | { kind: 'rest' }; // repos / pas de collège

/** 7 jours, index 0 = lundi … 6 = dimanche. */
export type WeekMornings = DayMorning[];

export type PlanningException = {
  id: string;
  date: ISODate;
  type: ActivityType;
  label?: string;
  /** true = décale (ou annule) le réveil ce jour-là ; false = événement du soir, neutre. */
  affectsMorning: boolean;
  morning?: { kind: 'start'; start: HHMM } | { kind: 'rest' };
  time?: HHMM; // heure indicative d'un événement du soir (si !affectsMorning)
};

export type EveningShower = {
  enabled: boolean;
  targetReady: HHMM; // heure « SdB chaude » pour la douche du soir
  days: number[]; // 0=lundi … 6=dimanche
};

export type AssistantPeriod = { id: string; from: ISODate; to: ISODate; label?: string };

/** Marges réglables (corrige le « 1h30 codé en dur »). */
export type ComfortParams = {
  wakeBeforeFirstMin: number; // réveil = 1er cours − N min (défaut 90)
  departBeforeFirstMin: number; // part ~N min avant le 1er cours (défaut 15)
};

export type PlanningV2 = {
  version: 2;
  defaultStart: HHMM;
  abEnabled: boolean;
  /** Ancre de parité A/B : le lundi de CETTE semaine ISO est A si abAnchorIsA.
   *  Ré-ancrable d'un tap par Isabelle (robuste aux vacances qui « sautent » l'alternance). */
  abAnchorMonday: ISODate;
  abAnchorIsA: boolean;
  weekA: WeekMornings;
  weekB: WeekMornings; // ignorée si !abEnabled
  comfort: ComfortParams;
  eveningShower: EveningShower;
  exceptions: PlanningException[];
  assistantPeriods: AssistantPeriod[];
};

/** Résolution effective du matin d'une date (après cascade). */
export type ResolvedMorning =
  | { kind: 'start'; start: HHMM; halfGroup?: boolean }
  | { kind: 'afternoon' }
  | { kind: 'rest' };

export const DAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
export const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (s: unknown): s is HHMM => typeof s === 'string' && HHMM_RE.test(s);

export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minToHHMM(min: number): HHMM {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "08:00" → "8h00", "08:30" → "8h30" (affichage FR chaleureux). */
export function fmtHHMM(hhmm: string): string {
  if (!isHHMM(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':');
  return `${parseInt(h, 10)}h${m}`;
}

/** Lundi (00:00 local) de la semaine ISO de d. */
export function isoMonday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = lundi
  x.setDate(x.getDate() - dow);
  return x;
}

export function mondayISO(d: Date): ISODate {
  const m = isoMonday(d);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
}

export function parseISO(d: string): Date {
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(y || 1970, (mo || 1) - 1, da || 1);
}

/** 0 = lundi … 6 = dimanche. */
export function weekdayOf(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Semaine par défaut : lun–ven « comme d'habitude », week-end repos. */
export function defaultWeek(): WeekMornings {
  return [
    { kind: 'inherit' },
    { kind: 'inherit' },
    { kind: 'inherit' },
    { kind: 'inherit' },
    { kind: 'inherit' },
    { kind: 'rest' },
    { kind: 'rest' }
  ];
}

export function defaultPlanningV2(): PlanningV2 {
  return {
    version: 2,
    defaultStart: '08:00',
    abEnabled: false,
    abAnchorMonday: mondayISO(new Date()),
    abAnchorIsA: true,
    weekA: defaultWeek(),
    weekB: defaultWeek(),
    comfort: { wakeBeforeFirstMin: 90, departBeforeFirstMin: 15 },
    eveningShower: { enabled: false, targetReady: '19:30', days: [0, 1, 2, 3, 4] },
    exceptions: [],
    assistantPeriods: []
  };
}

/** Lettre de semaine (A|B) pour une date, d'après l'ancre de parité. */
export function abLetterFor(dateISO: string, plan: PlanningV2): 'A' | 'B' {
  if (!plan.abEnabled) return 'A';
  const anchor = isoMonday(parseISO(plan.abAnchorMonday));
  const target = isoMonday(parseISO(dateISO));
  const weeks = Math.round((target.getTime() - anchor.getTime()) / (7 * 86400000));
  const samePar = ((weeks % 2) + 2) % 2 === 0;
  const isA = samePar ? plan.abAnchorIsA : !plan.abAnchorIsA;
  return isA ? 'A' : 'B';
}

/** Matin effectif d'une date : exception datée > semaine A|B > rythme habituel. */
export function morningForDate(dateISO: string, plan: PlanningV2): ResolvedMorning {
  const exc = plan.exceptions.find((e) => e.date === dateISO);
  if (exc) {
    if (!exc.affectsMorning) return { kind: 'rest' };
    if (exc.morning?.kind === 'start') return { kind: 'start', start: exc.morning.start };
    return { kind: 'rest' };
  }
  const week = abLetterFor(dateISO, plan) === 'A' ? plan.weekA : plan.weekB;
  const day = week[weekdayOf(parseISO(dateISO))] ?? { kind: 'inherit' };
  if (day.kind === 'rest') return { kind: 'rest' };
  if (day.kind === 'afternoon') return { kind: 'afternoon' };
  if (day.kind === 'start') return { kind: 'start', start: day.start, halfGroup: day.halfGroup };
  return { kind: 'start', start: plan.defaultStart };
}

/** Heure de réveil lisible (« 6h30 ») à partir d'une heure de 1er cours. */
export function wakeLabelFor(start: HHMM, comfort: ComfortParams): string {
  return fmtHHMM(minToHHMM(toMin(start) - comfort.wakeBeforeFirstMin));
}
