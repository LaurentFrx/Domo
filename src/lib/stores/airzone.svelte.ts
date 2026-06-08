/**
 * Airzone store — pilotage du système gainable Airzone.
 *
 * ⚠️ Sécurité : le store ne parle JAMAIS au bridge en direct. Il passe par les
 * routes backend Domo /api/airzone/* (derrière le guard d'auth), qui relaient
 * en server-to-server vers airzone-bridge sur la loopback du VPS. Le bridge
 * n'est plus exposé publiquement.
 *
 * Contrat backend (= contrat bridge, snake_case) :
 *   GET  /api/airzone/status   → {connected, last_update, system_id, zones[]}
 *   POST /api/airzone/command  body {zoneId, on?, setpoint?, mode?}
 *
 * Le mode est GLOBAL au système Airzone : le bridge route la commande 'mode'
 * vers la zone master. Optimisme local + réconciliation au prochain poll.
 */

export type AirzoneMode = 'stop' | 'cooling' | 'heating' | 'fan' | 'dry' | 'auto' | 'unknown';

export type AirzoneZone = {
  id: number;
  name: string;
  on: boolean;
  roomTemp: number | null;
  humidity: number | null;
  setpoint: number | null;
  mode: AirzoneMode;
  modeRaw: number | null;
  availableModes: AirzoneMode[] | null;
  minTemp: number;
  maxTemp: number;
  tempStep: number;
  /** Zone en demande (air effectivement soufflé). */
  demand: boolean;
  isMaster: boolean;
  masterZoneId: number | null;
  /** Thermostat radio : batterie % (null si filaire). */
  battery: number | null;
  /** Thermostat radio : couverture signal % (null si filaire). */
  coverage: number | null;
};

// ─── Contrat backend/bridge (snake_case) ────────────────────────────────
type ApiZone = {
  id: number;
  name: string;
  on: boolean;
  room_temp: number | null;
  humidity: number | null;
  setpoint: number | null;
  mode: string;
  mode_raw: number | null;
  available_modes: string[] | null;
  min_temp: number | null;
  max_temp: number | null;
  temp_step: number | null;
  demand: boolean;
  is_master: boolean;
  master_zone_id: number | null;
  battery: number | null;
  coverage: number | null;
};
type StatusPayload = {
  connected: boolean;
  last_update: number | null;
  system_id: number;
  zones: ApiZone[];
};
type Command = Partial<{ on: boolean; setpoint: number; mode: AirzoneMode }>;

const STATUS_URL = '/api/airzone/status';
const COMMAND_URL = '/api/airzone/command';
const POLL_INTERVAL_MS = 30_000;
const MODES: AirzoneMode[] = ['stop', 'cooling', 'heating', 'fan', 'dry', 'auto', 'unknown'];

function asMode(s: string | null | undefined): AirzoneMode {
  return (MODES as string[]).includes(s ?? '') ? (s as AirzoneMode) : 'unknown';
}

function clamp(v: number, lo: number, hi: number, step: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v / step) * step));
}

// Seed mock : affichage gracieux avant la 1re réponse du backend.
const MOCK_ZONES: AirzoneZone[] = [
  {
    id: 1,
    name: 'Parents',
    on: false,
    roomTemp: 24,
    humidity: 60,
    setpoint: 24,
    mode: 'cooling',
    modeRaw: 2,
    availableModes: ['stop', 'cooling', 'heating', 'fan', 'dry'],
    minTemp: 18,
    maxTemp: 30,
    tempStep: 0.5,
    demand: false,
    isMaster: true,
    masterZoneId: 1,
    battery: null,
    coverage: null
  },
  {
    id: 2,
    name: 'Amis',
    on: false,
    roomTemp: 24,
    humidity: 60,
    setpoint: 24,
    mode: 'cooling',
    modeRaw: 2,
    availableModes: null,
    minTemp: 18,
    maxTemp: 30,
    tempStep: 0.5,
    demand: false,
    isMaster: false,
    masterZoneId: 1,
    battery: 70,
    coverage: 90
  },
  {
    id: 3,
    name: 'Bureau',
    on: false,
    roomTemp: 24,
    humidity: 60,
    setpoint: 24,
    mode: 'cooling',
    modeRaw: 2,
    availableModes: null,
    minTemp: 18,
    maxTemp: 30,
    tempStep: 0.5,
    demand: false,
    isMaster: false,
    masterZoneId: 1,
    battery: 70,
    coverage: 70
  }
];

class AirzoneState {
  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'error'>('idle');
  lastError = $state<string | null>(null);
  lastUpdate = $state<Date | null>(null);
  systemId = $state(1);
  zones = $state<AirzoneZone[]>(MOCK_ZONES);

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private reconcileTimers: ReturnType<typeof setTimeout>[] = [];

  // Optimisme « épinglé » : valeurs commandées récemment (par zone), conservées
  // par-dessus les snapshots tant qu'elles ne sont pas CONFIRMÉES par le bridge
  // (ou expirées). L'Airzone applique avec un délai — surtout l'extinction du
  // master qui refroidit — donc une relecture trop précoce ferait « revenir » le
  // bouton (réaction contradictoire).
  private pins = new Map<number, { patch: Partial<AirzoneZone>; until: number }>();
  private readonly PIN_MS = 7000;

  /** Mode système (= mode de la zone master). */
  systemMode = $derived.by<AirzoneMode>(() => {
    const master = this.zones.find((z) => z.isMaster) ?? this.zones[0];
    return master?.mode ?? 'unknown';
  });

  /** Modes proposables (lus sur la zone master). */
  availableModes = $derived.by<AirzoneMode[]>(() => {
    const master = this.zones.find((z) => z.isMaster) ?? this.zones[0];
    return master?.availableModes ?? ['stop', 'cooling', 'heating', 'fan', 'dry'];
  });

  connect() {
    if (typeof window === 'undefined') return;
    if (this.intervalId !== null) return;
    this.poll();
    this.intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  disconnect() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.reconcileTimers.forEach((t) => clearTimeout(t));
    this.reconcileTimers = [];
    this.pins.clear();
  }

  private mapZone(z: ApiZone): AirzoneZone {
    return {
      id: z.id,
      name: z.name,
      on: !!z.on,
      roomTemp: z.room_temp,
      humidity: z.humidity,
      setpoint: z.setpoint,
      mode: asMode(z.mode),
      modeRaw: z.mode_raw,
      availableModes: z.available_modes ? z.available_modes.map(asMode) : null,
      minTemp: z.min_temp ?? 16,
      maxTemp: z.max_temp ?? 30,
      tempStep: z.temp_step ?? 0.5,
      demand: !!z.demand,
      isMaster: !!z.is_master,
      masterZoneId: z.master_zone_id,
      battery: z.battery,
      coverage: z.coverage
    };
  }

  /**
   * Mode SYSTÈME global : l'Airzone n'a qu'UN mode pour tout le système, mais le
   * bridge ne bascule que le champ `mode` de la zone master à la relecture (les
   * autres zones gardent transitoirement leur ancien mode tant que son poll 15 s
   * n'a pas propagé). On aligne donc toutes les zones sur le mode de la master →
   * jamais deux zones avec des modes contradictoires.
   */
  private normalizeMode(zones: AirzoneZone[]): AirzoneZone[] {
    const master = zones.find((z) => z.isMaster) ?? zones[0];
    const m = master?.mode;
    if (!m) return zones;
    return zones.map((z) => (z.mode === m ? z : { ...z, mode: m }));
  }

  /** Réapplique l'optimisme épinglé par-dessus un snapshot (cf. `pins`). */
  private applyPins(zones: AirzoneZone[]): AirzoneZone[] {
    if (this.pins.size === 0) return zones;
    const now = Date.now();
    return zones.map((z) => {
      const p = this.pins.get(z.id);
      if (!p) return z;
      if (p.until < now) {
        this.pins.delete(z.id);
        return z;
      }
      // Confirmé dès que le snapshot reflète déjà toutes les valeurs épinglées.
      const confirmed = Object.entries(p.patch).every(
        ([k, v]) => (z as Record<string, unknown>)[k] === v
      );
      if (confirmed) {
        this.pins.delete(z.id);
        return z;
      }
      return { ...z, ...p.patch };
    });
  }

  private applySnapshot(p: StatusPayload) {
    if (!Array.isArray(p.zones)) return;
    // applyPins AVANT normalizeMode : si le mode de la master est encore épinglé,
    // normalizeMode propage la bonne valeur à toutes les zones.
    this.zones = this.normalizeMode(this.applyPins(p.zones.map((z) => this.mapZone(z))));
    this.systemId = p.system_id ?? this.systemId;
  }

  private async poll() {
    this.status = 'polling';
    try {
      const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(14_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as StatusPayload;
      this.applySnapshot(json);
      this.connected = !!json.connected;
      this.status = 'connected';
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      // Backend/bridge KO → on garde le dernier état affiché (ou le mock).
      this.connected = false;
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }

  // ─── Mutations optimistes ────────────────────────────────────────────
  private patchZone(zoneId: number, patch: Partial<AirzoneZone>) {
    const idx = this.zones.findIndex((z) => z.id === zoneId);
    if (idx < 0) return;
    this.zones[idx] = { ...this.zones[idx], ...patch };
    this.lastUpdate = new Date();
  }

  /** Épingle une valeur optimiste (fusionnée) jusqu'à confirmation/expiration. */
  private pin(zoneId: number, patch: Partial<AirzoneZone>) {
    const ex = this.pins.get(zoneId);
    this.pins.set(zoneId, {
      patch: { ...ex?.patch, ...patch },
      until: Date.now() + this.PIN_MS
    });
  }

  /**
   * Re-poll de réconciliation DÉBOUNCÉ. Après une rafale de commandes (l'user
   * tapote plusieurs zones d'affilée), on ne déclenche qu'UN seul poll, une fois
   * la rafale retombée. On ne réécrit PLUS l'état depuis la réponse de chaque
   * commande : ces snapshots complets, résolus dans le désordre, écrasaient
   * l'optimisme des AUTRES zones → boutons qui « sautent », réactions contradictoires.
   */
  private schedulePollSoon() {
    this.reconcileTimers.forEach((t) => clearTimeout(t));
    // Deux relectures : 1,5 s (commande appliquée vite, cas courant) puis 4,5 s
    // (laisse le temps au matériel lent, ex. extinction du master). Les pins
    // protègent l'optimisme entre les deux si la 1re relecture est encore périmée.
    this.reconcileTimers = [1500, 4500].map((ms) => setTimeout(() => this.poll(), ms));
  }

  private async sendCommand(zoneId: number, cmd: Command) {
    try {
      const res = await fetch(COMMAND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zoneId, ...cmd }),
        signal: AbortSignal.timeout(16_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json().catch(() => ({}));
      this.lastError = null;
    } catch (e) {
      // L'optimiste reste affiché ; le re-poll débouncé corrigera (ou 403 si write off).
      this.lastError = (e as Error).message;
    } finally {
      this.schedulePollSoon();
    }
  }

  setOn(zoneId: number, on: boolean) {
    this.patchZone(zoneId, { on });
    this.pin(zoneId, { on });
    this.sendCommand(zoneId, { on });
  }

  setSetpoint(zoneId: number, value: number) {
    const z = this.zones.find((x) => x.id === zoneId);
    const v = z ? clamp(value, z.minTemp, z.maxTemp, z.tempStep) : value;
    this.patchZone(zoneId, { setpoint: v });
    this.pin(zoneId, { setpoint: v });
    this.sendCommand(zoneId, { setpoint: v });
  }

  /** Mode GLOBAL : optimiste sur toutes les zones, routé + épinglé sur la master. */
  setMode(mode: AirzoneMode) {
    const master = this.zones.find((z) => z.isMaster) ?? this.zones[0];
    this.zones = this.zones.map((z) => ({ ...z, mode }));
    if (master) this.pin(master.id, { mode });
    this.sendCommand(master?.id ?? 1, { mode });
  }
}

export const airzone = new AirzoneState();
