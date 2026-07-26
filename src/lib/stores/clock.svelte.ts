/**
 * Horloge PARTAGÉE — une seule pour toute l'app.
 *
 * « Mesuré il y a 4 min » se fige sans horloge réactive : la valeur ne change
 * pas, donc rien ne recalcule l'âge, donc l'écran affirme « il y a 4 min »
 * pendant une heure. Et une horloge par carte multiplierait les timers, alors
 * que le commit 40c95e6 vient précisément de corriger des fuites de timers.
 *
 * Cadence 10 s : `ageLabel` a une résolution à la minute et les seuils de
 * `freshnessOf` valent au moins 30 s — descendre à 1 s serait du réveil CPU pur
 * sur l'iPhone. Visibility-aware comme tous les stores de polling du projet :
 * pause en arrière-plan, remise à l'heure immédiate au retour.
 */
class Clock {
  #now = $state(Date.now());
  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityHandler: (() => void) | null = null;

  get now(): number {
    return this.#now;
  }

  connect(): void {
    if (typeof window === 'undefined') return; // SSR
    if (this.#visibilityHandler !== null) return; // déjà connecté (idempotent)

    this.#visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.#now = Date.now(); // remise à l'heure AVANT de réarmer
        this.#start();
      } else {
        this.#stop();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
    this.#start();
  }

  disconnect(): void {
    this.#stop();
    if (this.#visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
  }

  #start(): void {
    if (this.#timer !== null) return; // jamais deux timers
    this.#timer = setInterval(() => (this.#now = Date.now()), 10_000);
  }

  #stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}

export const clock = new Clock();
