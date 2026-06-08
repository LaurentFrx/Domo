/**
 * Planning store — planning d'Isabelle (modèle v2 « langage prof »).
 *
 * Sync cross-device via GET/PUT /api/planning. À chaque PUT, le serveur pousse
 * aussi le planning au daemon thermostat (cf. routes/api/planning). Ici : état
 * réactif + sauvegarde DEBOUNCÉE + mutations. La dérivation de la chauffe (réveil
 * = 1er cours − 1h30, etc.) se fait côté daemon ; voir $utils/planning-derive pour
 * les helpers d'affichage en lecture seule.
 */

import {
  defaultPlanningV2,
  mondayISO,
  type PlanningV2,
  type DayMorning,
  type PlanningException,
  type EveningShower,
  type AssistantPeriod
} from '$utils/planning-derive';

class PlanningState {
  data = $state<PlanningV2>(defaultPlanningV2());
  hydrating = $state(false);
  saving = $state(false);
  lastError = $state<string | null>(null);
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  async hydrate() {
    if (typeof window === 'undefined') return;
    this.hydrating = true;
    try {
      const res = await fetch('/api/planning');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as Partial<PlanningV2>;
      if (d && d.version === 2 && Array.isArray(d.weekA) && Array.isArray(d.weekB)) {
        this.data = d as PlanningV2;
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.hydrating = false;
    }
  }

  /** Sauvegarde DEBOUNCÉE (~600 ms) — évite de spammer le PUT (et la sync daemon)
   *  à chaque tick d'un input type=time. */
  save() {
    if (this.hydrating) return;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#flush(), 600);
  }

  async #flush() {
    if (typeof window === 'undefined') return;
    this.saving = true;
    try {
      const res = await fetch('/api/planning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify($state.snapshot(this.data))
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
    } finally {
      this.saving = false;
    }
  }

  /** Force l'envoi immédiat (ex. avant de quitter la page). */
  flushNow() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    return this.#flush();
  }

  // ─── Mutations ───
  setDefaultStart(hhmm: string) {
    this.data.defaultStart = hhmm;
    this.save();
  }

  setAbEnabled(on: boolean) {
    this.data.abEnabled = on;
    if (on) {
      // (Re)pose une ancre de parité sur la semaine courante si on active l'A/B.
      this.data.abAnchorMonday = mondayISO(new Date());
    }
    this.save();
  }

  /** Ré-ancre la parité : « cette semaine, je suis en <letter> » (anti-vacances). */
  reanchorThisWeek(letter: 'A' | 'B') {
    this.data.abAnchorMonday = mondayISO(new Date());
    this.data.abAnchorIsA = letter === 'A';
    this.save();
  }

  setDayMorning(week: 'A' | 'B', day: number, morning: DayMorning) {
    const w = week === 'A' ? this.data.weekA : this.data.weekB;
    w[day] = morning;
    this.save();
  }

  copyAtoB() {
    this.data.weekB = this.data.weekA.map((d) => ({ ...d }));
    this.save();
  }

  setComfort(wakeBeforeFirstMin: number, departBeforeFirstMin: number) {
    this.data.comfort = { wakeBeforeFirstMin, departBeforeFirstMin };
    this.save();
  }

  setEveningShower(es: EveningShower) {
    this.data.eveningShower = es;
    this.save();
  }

  // ─── Exceptions (journées spéciales) ───
  upsertException(exc: PlanningException) {
    const others = this.data.exceptions.filter((e) => e.id !== exc.id && e.date !== exc.date);
    this.data.exceptions = [...others, exc].sort((a, b) => a.date.localeCompare(b.date));
    this.save();
  }

  removeException(id: string) {
    this.data.exceptions = this.data.exceptions.filter((e) => e.id !== id);
    this.save();
  }

  // ─── Périodes assistante (pense-bête, neutre côté chauffe) ───
  addAssistantPeriod(p: AssistantPeriod) {
    this.data.assistantPeriods = [...this.data.assistantPeriods, p].sort((a, b) =>
      a.from.localeCompare(b.from)
    );
    this.save();
  }

  removeAssistantPeriod(id: string) {
    this.data.assistantPeriods = this.data.assistantPeriods.filter((p) => p.id !== id);
    this.save();
  }
}

export const planning = new PlanningState();
