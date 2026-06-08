/**
 * Thermostat store — pilotage du sèche-serviette (salle de bain).
 *
 * ⚠️ Le store ne parle JAMAIS au daemon en direct : il passe par les routes
 * backend Domo /api/thermostat/* (derrière le guard d'auth de hooks.server.ts),
 * qui relaient en server-to-server vers thermostat-bridge sur la loopback du VPS
 * (sortie du tunnel SSH inverse depuis le RPi4).
 *
 * La régulation (TPI), la lecture de la sonde (MQTT « Thermo SdB ») et la
 * commande du switch (Matter node 1) vivent DANS le daemon 24/7 — pas ici. Ce
 * store ne fait qu'AFFICHER l'état et ENVOYER des consignes.
 *
 * Contrat backend (= contrat daemon, snake_case) :
 *   GET  /api/thermostat/status  → StatusPayload
 *   POST /api/thermostat/command body {mode?, preset?, boost_minutes?,
 *                                      clear_override?, config?}  → StatusPayload
 *
 * Tant que le daemon n'est pas déployé, la route renvoie une erreur : le store
 * passe connected=false et garde le seed mock (affichage « hors ligne »).
 */

export type ThermostatPreset = 'frost' | 'eco' | 'comfort' | 'boost' | 'off' | 'manual';
export type ThermostatMode = 'auto' | 'manual';
export type ThermostatSafety = 'ok' | 'sensor_lost' | 'over_max' | 'window_open';

export type ThermostatOverride = {
  preset: ThermostatPreset;
  /** Expiration (Date) ; null = jusqu'à la prochaine transition planifiée. */
  until: Date | null;
};

export type ThermostatTransition = {
  at: Date;
  preset: ThermostatPreset;
};

/**
 * Config de régulation — miroir TS de la config daemon. Source de vérité =
 * settings.json côté Domo (éditée dans /reglages), poussée au daemon via
 * /command. Le daemon a les mêmes valeurs par défaut au cas où.
 */
export type ThermostatConfig = {
  presetTemps: { frost: number; eco: number; comfort: number; boost: number };
  /** Réactivité TPI à l'écart intérieur (T_cible − T_pièce). */
  coefInt: number;
  /** Compensation TPI des pertes via la T° extérieure. */
  coefExt: number;
  /** Durée d'un cycle PWM lent (s). */
  cycleSec: number;
  /** Durée par défaut d'un boost (min). */
  boostDefaultMin: number;
  /** Sécurité basse / haute (°C). */
  minTempC: number;
  maxTempC: number;
  /** Détection fenêtre ouverte : chute de N °C en M min → coupe. */
  windowDropC: number;
  windowDropMin: number;
  /** Pré-chauffe avant l'heure cible d'un créneau confort (min). */
  preheatMin: number;
};

export const DEFAULT_THERMOSTAT_CONFIG: ThermostatConfig = {
  presetTemps: { frost: 7, eco: 16, comfort: 22, boost: 24 },
  coefInt: 0.6,
  coefExt: 0.01,
  cycleSec: 300,
  boostDefaultMin: 30,
  minTempC: 5,
  maxTempC: 27,
  windowDropC: 1.5,
  windowDropMin: 5,
  preheatMin: 30
};

// ─── Contrat backend/daemon (snake_case) ────────────────────────────────
type ApiOverride = { preset: string; until: number | null } | null;
type ApiTransition = { at: number; preset: string } | null;
type StatusPayload = {
  connected: boolean;
  last_update: number | null;
  room_temp_c: number | null;
  humidity: number | null;
  outdoor_temp_c: number | null;
  switch_on: boolean | null;
  switch_available: boolean;
  duty_cycle: number | null;
  active_preset: string;
  target_temp_c: number | null;
  mode: string;
  override: ApiOverride;
  reason: string | null;
  next_transition: ApiTransition;
  window_open: boolean;
  safety: string;
};

type Command = Partial<{
  mode: ThermostatMode;
  preset: ThermostatPreset;
  boost_minutes: number;
  clear_override: boolean;
  config: Record<string, unknown>;
}>;

const STATUS_URL = '/api/thermostat/status';
const COMMAND_URL = '/api/thermostat/command';
const POLL_INTERVAL_MS = 15_000;
const TIMEOUT_MS = 8_000;

const PRESETS: ThermostatPreset[] = ['frost', 'eco', 'comfort', 'boost', 'off', 'manual'];
const asPreset = (s: string | null | undefined): ThermostatPreset =>
  (PRESETS as string[]).includes(s ?? '') ? (s as ThermostatPreset) : 'off';
const asMode = (s: string | null | undefined): ThermostatMode =>
  s === 'manual' ? 'manual' : 'auto';
const asSafety = (s: string): ThermostatSafety =>
  s === 'sensor_lost' || s === 'over_max' || s === 'window_open' ? s : 'ok';
const toDate = (s: number | null | undefined): Date | null =>
  typeof s === 'number' ? new Date(s * 1000) : null;

function snakeConfig(c: ThermostatConfig): Record<string, unknown> {
  return {
    preset_temps: c.presetTemps,
    coef_int: c.coefInt,
    coef_ext: c.coefExt,
    cycle_sec: c.cycleSec,
    boost_default_min: c.boostDefaultMin,
    min_temp_c: c.minTempC,
    max_temp_c: c.maxTempC,
    window_drop_c: c.windowDropC,
    window_drop_min: c.windowDropMin,
    preheat_min: c.preheatMin
  };
}

class ThermostatState {
  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'error'>('idle');
  lastError = $state<string | null>(null);
  lastUpdate = $state<Date | null>(null);

  // ─── État de régulation (depuis le daemon ; seed mock avant connexion) ───
  /** Température mesurée par « Thermo SdB » (°C). */
  roomTempC = $state<number | null>(19);
  humidity = $state<number | null>(55);
  /** T° extérieure utilisée par le terme coef_ext du TPI. */
  outdoorTempC = $state<number | null>(null);
  /** État réel du switch Matter node 1 (null = inconnu). */
  switchOn = $state<boolean | null>(null);
  switchAvailable = $state(false);
  /** % du cycle où le switch est ON (0..1) — sortie du TPI. */
  dutyCycle = $state<number | null>(null);
  activePreset = $state<ThermostatPreset>('eco');
  /** Consigne effective du preset actif (°C). */
  targetTempC = $state<number | null>(16);
  mode = $state<ThermostatMode>('auto');
  override = $state<ThermostatOverride | null>(null);
  /** Explication lisible de la consigne courante (« Confort jusqu'à 8h… »). */
  reason = $state<string | null>(null);
  nextTransition = $state<ThermostatTransition | null>(null);
  windowOpen = $state(false);
  safety = $state<ThermostatSafety>('ok');

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onVisibility: (() => void) | null = null;

  /** Démarre le polling visibility-aware (pause en arrière-plan + refetch au
   *  retour de visibilité). Idempotent. */
  connect() {
    if (typeof document === 'undefined') return;
    if (this.intervalId !== null) return;
    this.poll();
    this.intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') this.poll();
    }, POLL_INTERVAL_MS);
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') this.poll();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  disconnect() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.onVisibility) {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
  }

  private applySnapshot(p: StatusPayload) {
    this.roomTempC = p.room_temp_c;
    this.humidity = p.humidity;
    this.outdoorTempC = p.outdoor_temp_c;
    this.switchOn = p.switch_on;
    this.switchAvailable = !!p.switch_available;
    this.dutyCycle = p.duty_cycle;
    this.activePreset = asPreset(p.active_preset);
    this.targetTempC = p.target_temp_c;
    this.mode = asMode(p.mode);
    this.override = p.override
      ? { preset: asPreset(p.override.preset), until: toDate(p.override.until) }
      : null;
    this.reason = p.reason;
    this.nextTransition = p.next_transition
      ? {
          at: toDate(p.next_transition.at) ?? new Date(),
          preset: asPreset(p.next_transition.preset)
        }
      : null;
    this.windowOpen = !!p.window_open;
    this.safety = asSafety(p.safety);
  }

  private async poll() {
    this.status = 'polling';
    try {
      const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as StatusPayload;
      this.applySnapshot(data);
      this.connected = !!data.connected;
      this.status = 'connected';
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      // Daemon KO → on garde le dernier état affiché (ou le seed mock).
      this.connected = false;
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }

  /** Relit l'état immédiatement (p.ex. après une commande). */
  refresh() {
    return this.poll();
  }

  private async sendCommand(cmd: Command) {
    try {
      const res = await fetch(COMMAND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as StatusPayload;
      this.applySnapshot(data);
      this.connected = !!data.connected;
      this.lastUpdate = new Date();
      this.lastError = null;
    } catch (e) {
      // L'optimiste reste affiché ; le prochain poll réconciliera.
      this.lastError = (e as Error).message;
      this.poll();
    }
  }

  // ─── Commandes (optimisme local + réconciliation au retour serveur) ───
  setMode(mode: ThermostatMode) {
    this.mode = mode;
    this.sendCommand({ mode });
  }

  /** Force un preset (crée un override côté daemon quand on est en auto). */
  setPreset(preset: ThermostatPreset) {
    this.activePreset = preset;
    this.sendCommand({ preset });
  }

  /** Coup de boost (durée en min ; 0/absent = durée par défaut du daemon). */
  boost(minutes?: number) {
    this.activePreset = 'boost';
    this.sendCommand({ boost_minutes: minutes ?? 0 });
  }

  /** Repasse en planning auto (annule l'override manuel). */
  clearOverride() {
    this.override = null;
    this.sendCommand({ clear_override: true });
  }

  /** Pousse la config de régulation au daemon (après édition dans /reglages). */
  pushConfig(config: ThermostatConfig) {
    return this.sendCommand({ config: snakeConfig(config) });
  }
}

export const thermostat = new ThermostatState();
