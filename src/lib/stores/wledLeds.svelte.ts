/**
 * Aperçu LED en temps réel — CLIENT.
 *
 * Reçoit du serveur (SSE /api/wled/leds) la couleur RÉELLE de chaque LED,
 * telle que le firmware la sort : ce n'est plus une reconstitution à partir de
 * l'effet et de la palette, c'est l'image du ruban.
 *
 * La trame n'est PAS un `$state` : à 12 images/s, elle re-rendrait toute la
 * feuille douze fois par seconde. Elle est lue par une boucle rAF dans le
 * composant qui peint (même principe que `liveLevel` du mode musique). Seuls
 * `active` (des trames arrivent) et `unavailable` sont réactifs — ils
 * décident du repli vers le rendu calculé.
 *
 * Refcounté et visibility-aware : le module n'est sollicité que tant qu'un
 * écran regarde vraiment, et l'onglet en arrière-plan libère la connexion.
 */

class WledLedsStore {
  /** Des trames arrivent en ce moment (sinon : rendu calculé). */
  active = $state(false);
  /** Le serveur a dit que l'aperçu temps réel n'existe pas ici (mock). */
  unavailable = $state(false);

  /** Dernière trame : en-tête 'L' + version, puis 3 octets par LED. NON réactif. */
  frame: Uint8Array | null = null;
  /** Horodatage de la dernière trame (le peintre sait si l'image est fraîche). */
  frameAt = 0;

  #es: EventSource | null = null;
  #refs = 0;
  #vis: (() => void) | null = null;

  /** Nombre de LED de la dernière trame (0 si aucune). */
  get count(): number {
    return this.frame ? (this.frame.length - 2) / 3 : 0;
  }

  /**
   * Couleur d'une LED (index physique) — `null` hors trame. Le canal blanc est
   * déjà fondu dans le RGB par le firmware : c'est la couleur vue.
   */
  led(i: number): [number, number, number] | null {
    const f = this.frame;
    if (!f) return null;
    const p = 2 + i * 3;
    if (p + 2 >= f.length) return null;
    return [f[p], f[p + 1], f[p + 2]];
  }

  open(): void {
    this.#refs++;
    this.#connect();
    if (!this.#vis && typeof document !== 'undefined') {
      this.#vis = () => {
        if (document.visibilityState === 'hidden') this.#disconnect();
        else if (this.#refs > 0) this.#connect();
      };
      document.addEventListener('visibilitychange', this.#vis);
    }
  }

  close(): void {
    this.#refs = Math.max(0, this.#refs - 1);
    if (this.#refs === 0) this.#disconnect();
  }

  #connect(): void {
    if (this.#es || typeof EventSource === 'undefined') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const es = new EventSource('/api/wled/leds');
    this.#es = es;
    es.addEventListener('unavailable', () => {
      this.unavailable = true;
      this.active = false;
    });
    es.onmessage = (m) => {
      const b64 = m.data as string;
      if (!b64) return;
      try {
        const bin = atob(b64);
        const f = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) f[i] = bin.charCodeAt(i);
        this.frame = f;
        this.frameAt = Date.now();
        if (!this.active) this.active = true;
        this.unavailable = false;
      } catch {
        /* trame illisible : on garde la précédente */
      }
    };
    // EventSource se reconnecte seul ; on ne coupe `active` que sur fermeture
    // volontaire (sinon l'aperçu clignoterait à chaque micro-coupure).
  }

  #disconnect(): void {
    this.#es?.close();
    this.#es = null;
    this.active = false;
    this.frame = null;
  }
}

export const wledLeds = new WledLedsStore();
