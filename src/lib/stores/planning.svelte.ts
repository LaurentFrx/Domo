/**
 * Planning store — planning d'occupation d'Isabelle, saisi dans Domo.
 *
 * Sync cross-device via GET/PUT /api/planning (data/planning.json côté Node).
 * Ce planning alimentera le moteur de créneaux de confort du daemon thermostat
 * (combiné au calendrier scolaire / fériés / agenda via Google côté daemon).
 *
 * Modèle : `week` = 7 jours (0 = lundi … 6 = dimanche), chacun une liste de
 * créneaux d'occupation { start, end } "HH:MM" ; `exceptions` = dates précises
 * qui surchargent la semaine type.
 */

export type TimeSlot = { start: string; end: string };
export type PlanningException = { date: string; slots: TimeSlot[] };

export const DAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
export const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

const emptyWeek = (): TimeSlot[][] => [[], [], [], [], [], [], []];

class PlanningState {
  /** 7 jours (index 0 = lundi). */
  week = $state<TimeSlot[][]>(emptyWeek());
  exceptions = $state<PlanningException[]>([]);

  hydrating = $state(false);
  saving = $state(false);
  lastError = $state<string | null>(null);

  async hydrate() {
    if (typeof window === 'undefined') return;
    this.hydrating = true;
    try {
      const res = await fetch('/api/planning');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { week?: TimeSlot[][]; exceptions?: PlanningException[] };
      this.week = Array.isArray(data.week) && data.week.length === 7 ? data.week : emptyWeek();
      this.exceptions = Array.isArray(data.exceptions) ? data.exceptions : [];
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.hydrating = false;
    }
  }

  async save() {
    if (typeof window === 'undefined') return;
    if (this.hydrating) return;
    this.saving = true;
    try {
      const res = await fetch('/api/planning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          week: $state.snapshot(this.week),
          exceptions: $state.snapshot(this.exceptions)
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.saving = false;
    }
  }

  // ─── Semaine type ───
  addSlot(day: number) {
    this.week[day] = [...this.week[day], { start: '07:00', end: '08:00' }];
    this.save();
  }
  removeSlot(day: number, idx: number) {
    this.week[day] = this.week[day].filter((_, i) => i !== idx);
    this.save();
  }
  copyDayToWeekdays(day: number) {
    const src = this.week[day].map((s) => ({ ...s }));
    for (let d = 0; d < 5; d++) this.week[d] = src.map((s) => ({ ...s }));
    this.save();
  }

  // ─── Exceptions ponctuelles ───
  addException(date: string) {
    if (!date || this.exceptions.some((e) => e.date === date)) return;
    this.exceptions = [...this.exceptions, { date, slots: [] }].sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    this.save();
  }
  removeException(date: string) {
    this.exceptions = this.exceptions.filter((e) => e.date !== date);
    this.save();
  }
  addExceptionSlot(date: string) {
    this.exceptions = this.exceptions.map((e) =>
      e.date === date ? { ...e, slots: [...e.slots, { start: '07:00', end: '08:00' }] } : e
    );
    this.save();
  }
  removeExceptionSlot(date: string, idx: number) {
    this.exceptions = this.exceptions.map((e) =>
      e.date === date ? { ...e, slots: e.slots.filter((_, i) => i !== idx) } : e
    );
    this.save();
  }
}

export const planning = new PlanningState();
