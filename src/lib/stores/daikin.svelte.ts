/**
 * Daikin store — climatisation Onecta.
 *
 * Modes :
 *   - 'mock'    : valeurs réalistes (fallback tant que le bridge n'est pas
 *                 configuré, ou en cas d'erreur réseau).
 *   - 'direct'  : polling REST du microservice daikin-bridge sur le RPi4
 *                 (OAuth Onecta + cache), via le PROXY AUTHENTIFIÉ de Domo
 *                 (/api/daikin/* → loopback 8096). Le bridge n'est plus exposé
 *                 publiquement (Caddy ne laisse passer que le callback OAuth).
 *
 * Contrat JSON du proxy (snake_case, relayé du bridge) :
 *   GET  /api/daikin/status              → StatusPayload | 503 (non configuré)
 *   POST /api/daikin/units/{id}/command    body: Command (champs partiels)
 *
 * ⚠️ Onecta cloud est rate-limité (~200 req/jour). Le BRIDGE met l'état en
 * cache et n'interroge Onecta que toutes les ~10-15 min ; le FRONT poll le
 * cache du bridge (gratuit) toutes les 30 s. Les commandes consomment l'API
 * → on les envoie à la demande puis on re-poll le cache.
 *
 * Périmètre Domo (décisions Laurent 2026-05-28) :
 *   on garde : operationMode (heating/cooling/off), onOff, outdoor
 *              temperature, consigne par mode, fan speed (auto/quiet/
 *              level1..5), swing horizontal/vertical, statut connexion.
 *   ailleurs : conso → /energie ; ambiante + humidité → thermo Zigbee
 *              de la pièce (pas l'unité Daikin).
 */

export type DaikinOperationMode = 'heating' | 'cooling' | 'off';
export type FanSpeed = 'auto' | 'quiet' | 'level1' | 'level2' | 'level3' | 'level4' | 'level5';
export type SwingMode = 'off' | 'swing';

export type DaikinUnit = {
  id: string;
  name: string;
  zone: string;
  /** Connexion à l'unité (cloud Onecta accessible). */
  online: boolean;
  /** Alimentation. Indépendant du operationMode. */
  onOff: boolean;
  /** Mode opérationnel. */
  operationMode: DaikinOperationMode;
  /** Température extérieure mesurée par l'unité ext (°C). */
  outdoorTempC: number;
  /** Consigne en mode chaud (°C). */
  targetHeating: number;
  /** Consigne en mode froid (°C). */
  targetCooling: number;
  /** Vitesse ventilation. */
  fanSpeed: FanSpeed;
  /** Oscillation horizontale. */
  swingHorizontal: SwingMode;
  /** Oscillation verticale. */
  swingVertical: SwingMode;
};

// ─── Contrat bridge (snake_case) ────────────────────────────────────────
type ApiUnit = {
  id: string;
  name: string;
  zone: string;
  online: boolean;
  on_off: boolean;
  operation_mode: DaikinOperationMode;
  outdoor_temp_c: number;
  target_heating: number;
  target_cooling: number;
  fan_speed: FanSpeed;
  swing_horizontal: SwingMode;
  swing_vertical: SwingMode;
};
type StatusPayload = {
  connected: boolean;
  last_update: number | null;
  units: ApiUnit[];
};
type Command = Partial<{
  on_off: boolean;
  operation_mode: DaikinOperationMode;
  target_heating: number;
  target_cooling: number;
  fan_speed: FanSpeed;
  swing_horizontal: SwingMode;
  swing_vertical: SwingMode;
}>;

// Proxy server-side Domo (derrière l'auth cookie) — jamais le bridge en direct.
const API_BASE = '/api/daikin';
const POLL_INTERVAL_MS = 30_000;

const TARGET_MIN = 16;
const TARGET_MAX = 30;

function clampTarget(v: number): number {
  return Math.max(TARGET_MIN, Math.min(TARGET_MAX, Math.round(v * 2) / 2));
}

class DaikinState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');
  lastError = $state<string | null>(null);
  lastUpdate = $state<Date | null>(null);

  // Le seed MOCK a été supprimé. Il servait de « repli gracieux » avant la
  // première réponse du bridge, mais il inventait deux unités marquées
  // `online: true` — « Daikin Salon » à 22 °C en chauffage, et une « Daikin SdB »
  // qui ne correspond à AUCUN split réel. Bridge mort au chargement, la page
  // /climat affichait donc une carte entièrement fabriquée, plus une carte
  // fantôme, toutes deux avec une pastille verte « En ligne ».
  units = $state<DaikinUnit[]>([]);

  /** Une réponse du bridge a-t-elle déjà été reçue ? Distingue « on ne sait pas
   *  encore » (premier rendu, SSR) de « on a demandé et ça ne répond pas » — sans
   *  quoi l'app annoncerait une panne à chaque ouverture. */
  everPolled = $state(false);

  /** Des unités RÉELLES sont-elles connues ? Faux tant que le bridge n'a jamais
   *  répondu : il n'y a alors rien d'honnête à afficher. */
  get hasRealData(): boolean {
    return this.everPolled && this.units.length > 0;
  }

  /** Le bridge a répondu par le passé mais ne répond plus : les valeurs à l'écran
   *  sont les dernières connues, et les commandes n'aboutiront pas. */
  get offline(): boolean {
    return this.everPolled && !this.connected;
  }

  private intervalId: ReturnType<typeof setInterval> | null = null;

  // ─── Protection optimiste ─────────────────────────────────────────────
  // Après une commande, le(s) champ(s) touché(s) sont « verrouillés » pendant
  // une courte fenêtre : un snapshot de polling ne peut PAS réécraser la valeur
  // optimiste tant que (a) la fenêtre n'a pas expiré ET (b) le snapshot ne
  // confirme pas déjà cette valeur. Neutralise le yo-yo dû au rate-limit Onecta
  // (429 → cache périmé) et au délai de propagation cloud (lecture en avance).
  // Clé = `${unitId}:${champ}`.
  private pending = new Map<string, { value: unknown; until: number }>();
  private static readonly PROTECT_MS = 12_000;

  // ─── Débounce du +/− de consigne ──────────────────────────────────────
  // Le +/− applique l'optimiste IMMÉDIATEMENT (mutate) mais coalesce l'envoi :
  // 1 timer par unité, réarmé à chaque tap → un seul sendCommand à expiration.
  // Indispensable côté Onecta (rate-limit ~200 req/jour) : un +/− rapide ne
  // consomme qu'UNE commande cloud, pas une par incrément.
  private targetDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly TARGET_DEBOUNCE_MS = 700;

  private lockKey(unitId: string, field: keyof DaikinUnit) {
    return `${unitId}:${field}`;
  }

  private visibilityHandler: (() => void) | null = null;

  // ─── Connexion / polling du cache bridge ──────────────────────────────
  // Visibility-aware (contrat commun des stores, cf. apsystems) : arrière-plan →
  // poll suspendu ; retour au premier plan → refetch immédiat. daikin et airzone
  // étaient les deux seuls polleurs sans ce comportement : le snapshot restait
  // affiché jusqu'à 30 s après la réouverture de l'app.
  connect() {
    if (typeof window === 'undefined') return;
    if (this.visibilityHandler !== null) return; // idempotent
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.startPolling();
      } else {
        this.stopPolling();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.poll();
    this.startPolling();
  }

  private startPolling() {
    this.intervalId ??= setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  disconnect() {
    this.stopPolling();
    if (this.visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    // Annule les envois de consigne en attente (débounce) — sinon un timer
    // d'une session précédente pourrait tirer après reconnexion.
    for (const t of this.targetDebounce.values()) clearTimeout(t);
    this.targetDebounce.clear();
    // Lâche les verrous optimistes : à la reconnexion, le snapshot fait foi
    // (évite de garder des locks périmés d'une session de page précédente).
    this.pending.clear();
  }

  private async poll() {
    this.status = 'polling';
    // Marqué AVANT la requête : dès qu'on a essayé, on sait distinguer « pas
    // encore interrogé » de « interrogé sans réponse » — c'est ce qui autorise
    // les cartes à annoncer une panne sans le faire à chaque ouverture de l'app.
    this.everPolled = true;
    try {
      const res = await fetch(`${API_BASE}/status`, {
        signal: AbortSignal.timeout(15_000)
      });
      if (res.status === 503) {
        this.connected = false;
        this.mode = 'mock';
        this.status = 'unconfigured';
        const body = await res.json().catch(() => ({}));
        this.lastError = (body as { detail?: string }).detail || 'service unavailable';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as StatusPayload;
      this.applySnapshot(json);
      this.connected = true;
      this.mode = 'direct';
      this.status = 'connected';
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      // Réseau/bridge KO → on garde le dernier état RÉEL connu, et `offline`
      // devient vrai : la carte dit que ces valeurs datent et que les boutons
      // n'auront pas d'effet, au lieu de faire comme si de rien n'était.
      this.connected = false;
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }

  private applySnapshot(p: StatusPayload) {
    if (!Array.isArray(p.units)) return;
    const now = Date.now();
    // Champs pilotables → susceptibles d'être verrouillés après une commande.
    const PROTECTED: (keyof DaikinUnit)[] = [
      'onOff',
      'operationMode',
      'targetHeating',
      'targetCooling',
      'fanSpeed',
      'swingHorizontal',
      'swingVertical'
    ];
    this.units = p.units.map((u) => {
      const incoming: DaikinUnit = {
        id: u.id,
        name: u.name,
        zone: u.zone,
        online: u.online,
        onOff: u.on_off,
        operationMode: u.operation_mode,
        outdoorTempC: u.outdoor_temp_c ?? 0,
        targetHeating: u.target_heating,
        targetCooling: u.target_cooling,
        fanSpeed: u.fan_speed,
        swingHorizontal: u.swing_horizontal,
        swingVertical: u.swing_vertical
      };
      const current = this.units.find((c) => c.id === u.id);
      for (const field of PROTECTED) {
        const key = this.lockKey(u.id, field);
        const lock = this.pending.get(key);
        if (!lock) continue;
        if (now >= lock.until || incoming[field] === lock.value) {
          // Fenêtre expirée OU le snapshot confirme enfin la valeur → on lève le verrou.
          this.pending.delete(key);
        } else if (current) {
          // Toujours protégé et non confirmé → on conserve la valeur optimiste.
          (incoming as Record<string, unknown>)[field] = current[field];
        }
      }
      return incoming;
    });
  }

  // ─── Mutations locales (optimistes) ───────────────────────────────────
  private mutate(unitId: string, patch: Partial<DaikinUnit>) {
    const idx = this.units.findIndex((u) => u.id === unitId);
    if (idx < 0) return;
    this.units[idx] = { ...this.units[idx], ...patch };
    this.lastUpdate = new Date();
    // Verrouille chaque champ muté pour la durée de protection : un snapshot de
    // polling ne pourra pas le réécraser tant qu'il ne confirme pas la valeur.
    const until = Date.now() + DaikinState.PROTECT_MS;
    for (const field of Object.keys(patch) as (keyof DaikinUnit)[]) {
      this.pending.set(this.lockKey(unitId, field), { value: patch[field], until });
    }
  }

  /**
   * Envoie la commande au bridge (mode direct) puis re-poll pour refléter
   * l'état réel. En mode mock (pas de bridge) : mutation locale seulement.
   */
  private async sendCommand(unitId: string, cmd: Command) {
    try {
      const res = await fetch(`${API_BASE}/units/${encodeURIComponent(unitId)}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Pas de re-poll immédiat : le bridge a déjà mis son cache à jour de façon
      // optimiste (PATCH 2xx), et une relecture immédiate d'Onecta serait soit
      // rate-limitée (429), soit en retard de propagation → c'était la cause du
      // yo-yo. Le polling régulier (30 s) réconciliera, en respectant les verrous.
    } catch (e) {
      this.lastError = (e as Error).message;
      // L'optimiste reste affiché ; le prochain poll corrigera si besoin.
    }
  }

  setOnOff(unitId: string, onOff: boolean) {
    // Éteindre annule toute consigne débouncée en attente (ne pas écrire un
    // setpoint sur une unité qu'on vient de couper).
    if (!onOff) this.cancelTargetDebounce(unitId);
    this.mutate(unitId, { onOff });
    this.sendCommand(unitId, { on_off: onOff });
  }
  setOperationMode(unitId: string, operationMode: DaikinOperationMode) {
    // Une consigne débouncée en attente visait l'ANCIEN mode → l'annuler, sinon
    // on enverrait target_heating juste après être passé en froid (et v.v.).
    this.cancelTargetDebounce(unitId);
    this.mutate(unitId, { operationMode });
    this.sendCommand(unitId, { operation_mode: operationMode });
  }
  setTargetHeating(unitId: string, v: number) {
    const t = clampTarget(v);
    this.mutate(unitId, { targetHeating: t });
    this.sendCommand(unitId, { target_heating: t });
  }
  setTargetCooling(unitId: string, v: number) {
    const t = clampTarget(v);
    this.mutate(unitId, { targetCooling: t });
    this.sendCommand(unitId, { target_cooling: t });
  }

  /** Annule un envoi de consigne débouncé en attente (bascule de mode / extinction). */
  private cancelTargetDebounce(unitId: string) {
    const pending = this.targetDebounce.get(unitId);
    if (pending) {
      clearTimeout(pending);
      this.targetDebounce.delete(unitId);
    }
  }

  /**
   * Consigne réglée au +/− : optimiste instantané + envoi DÉBOUNCÉ.
   * Applique immédiatement la valeur (mutate → verrou 12 s, l'écran suit le
   * doigt) mais ne déclenche qu'UN seul sendCommand ~700 ms après le dernier
   * tap. Cible le champ du mode actif (heating→target_heating, cooling→
   * target_cooling) ; ignore si l'unité est à l'arrêt.
   */
  setTargetDebounced(unitId: string, v: number) {
    const unit = this.units.find((u) => u.id === unitId);
    if (!unit || unit.operationMode === 'off') return;
    const heating = unit.operationMode === 'heating';
    const t = clampTarget(v);
    // Optimiste immédiat sur le champ du mode COURANT (au moment du tap).
    this.mutate(unitId, heating ? { targetHeating: t } : { targetCooling: t });

    this.cancelTargetDebounce(unitId);
    this.targetDebounce.set(
      unitId,
      setTimeout(() => {
        this.targetDebounce.delete(unitId);
        // Relit le mode AU MOMENT DU TIR : si l'unité a basculé chaud/froid ou
        // s'est éteinte pendant la fenêtre (en plus de la purge faite par
        // setOperationMode/setOnOff), on n'envoie jamais la consigne au mauvais champ.
        const u = this.units.find((x) => x.id === unitId);
        if (!u || u.operationMode === 'off') return;
        this.sendCommand(
          unitId,
          u.operationMode === 'heating' ? { target_heating: t } : { target_cooling: t }
        );
      }, DaikinState.TARGET_DEBOUNCE_MS)
    );
  }
  setFanSpeed(unitId: string, fanSpeed: FanSpeed) {
    this.mutate(unitId, { fanSpeed });
    this.sendCommand(unitId, { fan_speed: fanSpeed });
  }
  setSwingHorizontal(unitId: string, swingHorizontal: SwingMode) {
    this.mutate(unitId, { swingHorizontal });
    this.sendCommand(unitId, { swing_horizontal: swingHorizontal });
  }
  setSwingVertical(unitId: string, swingVertical: SwingMode) {
    this.mutate(unitId, { swingVertical });
    this.sendCommand(unitId, { swing_vertical: swingVertical });
  }
}

export const daikin = new DaikinState();
