/**
 * Daikin store — climatisation Onecta.
 *
 * Modes :
 *   - 'mock'    : valeurs réalistes (fallback tant que le bridge n'est pas
 *                 configuré, ou en cas d'erreur réseau).
 *   - 'direct'  : polling REST du microservice daikin-bridge sur le RPi4
 *                 (OAuth Onecta + cache), proxié en HTTPS via Caddy comme
 *                 l'anker-bridge. Activé dès que PUBLIC_DAIKIN_URL est défini.
 *
 * Contrat JSON du bridge (snake_case) :
 *   GET  {PUBLIC_DAIKIN_URL}/api/status            → StatusPayload | 503 (non configuré)
 *   POST {PUBLIC_DAIKIN_URL}/api/units/{id}/command  body: Command (champs partiels)
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

import { env } from '$env/dynamic/public';

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

const PUBLIC_DAIKIN_URL = env.PUBLIC_DAIKIN_URL || '';
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

  // Seed mock : sert d'affichage tant que le bridge n'a pas répondu (fallback
  // gracieux — le dashboard ne casse pas avant que la clim soit connectée).
  units = $state<DaikinUnit[]>([
    {
      id: 'salon',
      name: 'Daikin Salon',
      zone: 'Séjour',
      online: true,
      onOff: true,
      operationMode: 'heating',
      outdoorTempC: 14.5,
      targetHeating: 22,
      targetCooling: 24,
      fanSpeed: 'auto',
      swingHorizontal: 'off',
      swingVertical: 'off'
    },
    {
      id: 'sdb',
      name: 'Daikin SdB',
      zone: 'Salle de bain',
      online: true,
      onOff: false,
      operationMode: 'heating',
      outdoorTempC: 14.5,
      targetHeating: 21,
      targetCooling: 25,
      fanSpeed: 'auto',
      swingHorizontal: 'off',
      swingVertical: 'off'
    }
  ]);

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

  private lockKey(unitId: string, field: keyof DaikinUnit) {
    return `${unitId}:${field}`;
  }

  // ─── Connexion / polling du cache bridge ──────────────────────────────
  connect() {
    if (typeof window === 'undefined') return;
    if (this.intervalId !== null) return;
    if (!PUBLIC_DAIKIN_URL) {
      // Pas de bridge configuré → on reste en mock, sans polling.
      this.mode = 'mock';
      this.status = 'unconfigured';
      return;
    }
    this.poll();
    this.intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  disconnect() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll() {
    if (!PUBLIC_DAIKIN_URL) return;
    this.status = 'polling';
    try {
      const res = await fetch(`${PUBLIC_DAIKIN_URL}/api/status`, {
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
      // Réseau/bridge KO → on garde le dernier état affiché (ou le mock).
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
    if (!PUBLIC_DAIKIN_URL) return;
    try {
      const res = await fetch(`${PUBLIC_DAIKIN_URL}/api/units/${unitId}/command`, {
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
    this.mutate(unitId, { onOff });
    this.sendCommand(unitId, { on_off: onOff });
  }
  setOperationMode(unitId: string, operationMode: DaikinOperationMode) {
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
