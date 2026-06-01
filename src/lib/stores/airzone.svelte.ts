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
  { id: 1, name: 'Parents', on: false, roomTemp: 24, humidity: 60, setpoint: 24, mode: 'cooling', modeRaw: 2, availableModes: ['stop', 'cooling', 'heating', 'fan', 'dry'], minTemp: 18, maxTemp: 30, tempStep: 0.5, demand: false, isMaster: true, masterZoneId: 1, battery: null, coverage: null },
  { id: 2, name: 'Amis', on: false, roomTemp: 24, humidity: 60, setpoint: 24, mode: 'cooling', modeRaw: 2, availableModes: null, minTemp: 18, maxTemp: 30, tempStep: 0.5, demand: false, isMaster: false, masterZoneId: 1, battery: 70, coverage: 90 },
  { id: 3, name: 'Bureau', on: false, roomTemp: 24, humidity: 60, setpoint: 24, mode: 'cooling', modeRaw: 2, availableModes: null, minTemp: 18, maxTemp: 30, tempStep: 0.5, demand: false, isMaster: false, masterZoneId: 1, battery: 70, coverage: 70 }
];

class AirzoneState {
  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'error'>('idle');
  lastError = $state<string | null>(null);
  lastUpdate = $state<Date | null>(null);
  systemId = $state(1);
  zones = $state<AirzoneZone[]>(MOCK_ZONES);

  private intervalId: ReturnType<typeof setInterval> | null = null;

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

  private applySnapshot(p: StatusPayload) {
    if (!Array.isArray(p.zones)) return;
    this.zones = p.zones.map((z) => this.mapZone(z));
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

  private async sendCommand(zoneId: number, cmd: Command) {
    try {
      const res = await fetch(COMMAND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zoneId, ...cmd }),
        signal: AbortSignal.timeout(16_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { zones?: ApiZone[] };
      if (Array.isArray(json.zones)) this.zones = json.zones.map((z) => this.mapZone(z));
      this.lastUpdate = new Date();
    } catch (e) {
      // L'optimiste reste affiché ; le prochain poll corrigera (ou 403 si write off).
      this.lastError = (e as Error).message;
    }
  }

  setOn(zoneId: number, on: boolean) {
    this.patchZone(zoneId, { on });
    this.sendCommand(zoneId, { on });
  }

  setSetpoint(zoneId: number, value: number) {
    const z = this.zones.find((x) => x.id === zoneId);
    const v = z ? clamp(value, z.minTemp, z.maxTemp, z.tempStep) : value;
    this.patchZone(zoneId, { setpoint: v });
    this.sendCommand(zoneId, { setpoint: v });
  }

  /** Mode GLOBAL : optimiste sur toutes les zones, routé vers la master côté bridge. */
  setMode(mode: AirzoneMode) {
    const master = this.zones.find((z) => z.isMaster) ?? this.zones[0];
    this.zones = this.zones.map((z) => ({ ...z, mode }));
    this.sendCommand(master?.id ?? 1, { mode });
  }
}

export const airzone = new AirzoneState();
