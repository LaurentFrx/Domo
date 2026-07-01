/**
 * Cumulus store — orchestrateur ECS.
 *
 * Logique métier : choisir l'état du relais Shelly cumulus selon mode, surplus
 * PV, tarif HC en cours, contraintes ANSES (anti-légionellose ≥60°C/7j), et
 * pièges (anti-cycling, fighting SB3).
 *
 * Pour l'instant, en mode mock : on lit la température "actuelle" et on expose
 * les paramètres de config. Les actions se traduisent en appel shelly.toggle()
 * dans une phase ultérieure.
 *
 * Modes :
 *   - 'mock'    : valeurs simulées
 *   - 'proxy'   : via HA (futur)
 *   - 'direct'  : Node/TS sur RPi4 (futur)
 */

import type { CumulusMode } from '$theme/tokens';
import { hourOfDay, cumulusTemp } from '$utils/mock-curves';
import { zigbee } from './zigbee.svelte';

/** Miroir client de la config serveur (src/lib/server/cumulus/types.ts). */
export interface CumulusConfigClient {
  profile: 'solar_first' | 'balanced' | 'comfort_first';
  tminConfortC: number;
  tmaxSondeC: number;
  comfortHysteresisC: number;
  rechargeHysteresisC: number;
  tempOffsetC: number;
  surplusOnW: number;
  surplusOffW: number;
  surplusOffGraceSec: number;
  minOnSec: number;
  minOffSec: number;
  antiCyclingSec: number;
  forecastFaibleKwh: number;
  autoOffDelaySec: number;
  tempStaleSec: number;
  tankFullPowerW: number;
  tankFullConfirmSec: number;
  faultConfirmSec: number;
}

export type CumulusAutoMode = 'auto' | 'manual' | 'off';

/** Libellés FR des raisons de décision (affichage carte). */
export const CUMULUS_REASON_LABELS: Record<string, string> = {
  cold_start: 'Initialisation',
  manual_on: 'Marche manuelle',
  manual_off: 'Arrêt manuel',
  vacation_off: 'Vacances',
  safety_high: 'Sécurité — eau très chaude',
  comfort_min: 'Confort garanti',
  legionella: 'Cycle anti-légionellose',
  solar: 'Surplus solaire',
  offpeak: 'Heures creuses',
  offpeak_boost: 'Heures creuses (renfort)',
  tank_full: 'Ballon plein',
  idle: 'En veille',
  anticycle_hold: 'Maintien (anti-cycle)'
};

/** Libellés FR des anomalies (bandeau d'alerte). '' = rien à signaler. */
export const CUMULUS_ANOMALY_LABELS: Record<string, string> = {
  none: '',
  relay_unreachable: 'Boîtier cumulus injoignable',
  sensor_stale: 'Sonde de température silencieuse',
  desync: 'Relais désynchronisé',
  heater_fault: 'Aucune chauffe détectée (résistance ?)'
};

class CumulusState {
  mode = $state<'mock' | 'proxy' | 'direct'>('mock');
  connected = $state(true);
  lastUpdate = $state<Date | null>(new Date());

  // ─── État ───────────────────────────────────────
  /** Mode courant. */
  currentMode = $state<CumulusMode>('PV');
  /** Température mock interne (placeholder avant/sans sonde réelle). */
  #mockTempC = $state(0);
  /**
   * Température mesurée (°C) — RÉELLE depuis la sonde Zigbee `thermo_cumulus`
   * (SNZB-02LD) si elle remonte, sinon repli sur le mock. La sonde est sur le
   * réseau Zigbee (store zigbee, connecté sur /climat & /pieces).
   */
  temperatureC = $derived.by(() => {
    const d = zigbee.devices.find((x) => x.friendlyName === 'thermo_cumulus');
    const t = d?.state?.temperature;
    return typeof t === 'number' ? +t.toFixed(1) : this.#mockTempC;
  });
  /** Tendance (°C/h, + = chauffe, - = refroidit). */
  trendCh = $state(0);
  /** Énergie injectée aujourd'hui (kWh). */
  energyTodayKwh = $state(0);
  /** Besoin estimé journée (kWh). */
  energyTargetKwh = $state(8);
  /** Date du prochain cycle anti-légionellose obligatoire. */
  nextLegionnellaCycle = $state<Date>(new Date(Date.now() + 4 * 24 * 3600 * 1000));

  // ─── Relais Shelly Pro 1 (RÉEL, via /api/cumulus/relay) ──────────
  /** État du relais cumulus : true = chauffe, false = arrêté, null = inconnu. */
  relayOn = $state<boolean | null>(null);
  /** Le boîtier Shelly répond-il ? (alimente la section Connexions). */
  relayConnected = $state(false);
  /** Température interne du boîtier (°C) — diagnostic. */
  relayTempC = $state<number | null>(null);
  #relayTimer: ReturnType<typeof setInterval> | null = null;
  #relayVis: (() => void) | null = null;

  // ─── Orchestrateur (RÉEL, via /api/cumulus/orchestrator) ─────────
  /** L'orchestrateur (moteur serveur) a-t-il répondu ? */
  orchestratorConnected = $state(false);
  /** Mode de pilotage : auto / manuel / vacances. */
  autoMode = $state<CumulusAutoMode>('auto');
  /** Raison brute de la décision courante (clé de CUMULUS_REASON_LABELS). */
  decisionReason = $state<string>('idle');
  /** Sous-mode (couleur) : OFF / PV / HC / FORCE. */
  decisionSubMode = $state<CumulusMode>('OFF');
  /** Anomalie courante (clé de CUMULUS_ANOMALY_LABELS). */
  anomaly = $state<string>('none');
  /** Horodatage du dernier tick (heartbeat — détecte un moteur muet). */
  lastTickTs = $state<number | null>(null);
  /** Température d'eau vue par le moteur (sert à estimer la RÉSERVE ; jamais affichée en °). */
  waterTempC = $state<number | null>(null);
  /** Ballon considéré plein (coupure thermostat mécanique détectée). */
  ballonCharged = $state(false);
  /** Horodatage de la dernière désinfection (ballon ≥60°C), null si jamais. */
  disinfectLastTs = $state<number | null>(null);
  /** Chauffe « à la demande » en cours (bouton Chauffer maintenant). */
  boostUntilFull = $state(false);
  // ── Réserve d'eau (estimateur E_avail, observation — lecture seule UI) ──
  /** Énergie chaude estimée disponible (Wh), null avant le 1er poll. */
  eAvailWh = $state<number | null>(null);
  /** Capacité du ballon à plein (Wh). */
  eFullWh = $state<number | null>(null);
  /** Réserve exprimée en nombre de douches équivalent. */
  showers = $state<number | null>(null);
  /** Dernier « ballon plein » (epoch ms), null si jamais observé. */
  lastAnchorTs = $state<number | null>(null);
  /** Config effective du moteur (cibles/seuils) — null avant le 1er poll. */
  config = $state<CumulusConfigClient | null>(null);
  /** ÉTAPE 2a — plan du planificateur prédictif (shadow, lecture seule UI). */
  plan = $state<{
    action: 'heat_now' | 'heat_hc' | 'wait_solar' | 'wait';
    reason: string;
    targetHour: number | null;
    showers: number;
    floorShowers: number;
    deficitWh: number;
    pvCoverW: number;
    batteryCoverW: number;
    gridDrawW: number;
    autoconsoPct: number;
    costNowEur: number;
    costHcEur: number;
    backstopHcHour: number | null;
    computedAt: number;
  } | null>(null);
  /** ÉTAPE 2a — timeline du jour (transitions de plan, chauffes, puisages, pleins). */
  shadowLog = $state<{ ts: number; kind: string; label: string; detail: string }[]>([]);
  #orchTimer: ReturnType<typeof setInterval> | null = null;
  #orchVis: (() => void) | null = null;

  // ─── Configuration (modifiable via /reglages) ────
  /** Seuil surplus PV pour ON (W). */
  surplusOnThreshold = $state(1500);
  /** Seuil surplus PV pour OFF (W). */
  surplusOffThreshold = $state(200);
  /** Durée minimale ON (sec). */
  minOnDurationSec = $state(300);
  /** Délai anti-cycling (sec). */
  antiCyclingSec = $state(600);
  /** Température cible (°C). */
  targetTempC = $state(62);
  /** Température max sécurité (°C). */
  maxTempC = $state(75);
  /** Plage HC : début (h décimal — 0.1 = 00:06). Fenêtre RÉELLE 00:06–08:06. */
  hcStartHour = $state(0.1);
  /** Plage HC : fin (h décimal — 8.1 = 08:06). */
  hcEndHour = $state(8.1);

  constructor() {
    this.generateMock();
  }

  private generateMock() {
    const h = hourOfDay();
    this.#mockTempC = +cumulusTemp(h).toFixed(1);
    // Tendance : dérivée numérique
    const next = cumulusTemp(h + 0.1);
    this.trendCh = +((next - this.#mockTempC) * 10).toFixed(1);
    this.energyTodayKwh = +(Math.max(0, h - 6) * 0.55).toFixed(2);
    this.currentMode =
      h >= 11 && h < 16 ? 'PV' : h >= this.hcStartHour && h < this.hcEndHour ? 'HC' : 'OFF';
  }

  /**
   * Tick périodique du mock — appelé par demo-ticker toutes les 3s.
   * Petit jitter ±0.15°C autour de la courbe théorique pour montrer
   * la mesure capteur "qui frémit". Le mode auto reste figé (pas de
   * basculement aléatoire).
   */
  tickMock() {
    if (this.mode !== 'mock') return;
    const h = hourOfDay();
    const base = cumulusTemp(h);
    const jitter = (Math.random() - 0.5) * 0.3; // ±0.15°C
    this.#mockTempC = +(base + jitter).toFixed(1);
    const next = cumulusTemp(h + 0.1);
    this.trendCh = +((next - base) * 10).toFixed(1);
    this.lastUpdate = new Date();
  }

  /** Pourcentage progression vs cible (0-100). Garde anti-division par zéro. */
  progressPercent = $derived(
    this.targetTempC > 0
      ? Math.min(100, Math.round((this.temperatureC / this.targetTempC) * 100))
      : 0
  );

  /** Puissance de la résistance cumulus (W). Élément 3000 W, conso réelle un peu
   *  moindre ; le Shelly Pro 1 ne mesure pas → valeur ESTIMÉE (≈), pas mesurée. */
  powerW = 2900;

  /** Coût horaire (€) — uniquement quand le relais chauffe VRAIMENT (état réel
   *  Shelly), au tarif HC/HP selon l'heure (fenêtre HC du store). */
  costPerHour = $derived.by(() => {
    if (this.relayOn !== true) return 0;
    const h = hourOfDay();
    const inHC = h >= this.hcStartHour && h < this.hcEndHour;
    return (this.powerW / 1000) * (inHC ? 0.1812 : 0.2318);
  });

  setMode(mode: CumulusMode) {
    this.currentMode = mode;
  }

  // ─── Relais réel (Shelly Pro 1) ─────────────────
  /** Lecture de l'état du relais. Marque relayConnected selon la réponse. */
  async refreshRelay() {
    try {
      const res = await fetch('/api/cumulus/relay', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      this.relayOn = typeof d.on === 'boolean' ? d.on : null;
      this.relayTempC = typeof d.tC === 'number' ? d.tC : null;
      this.relayConnected = true;
      this.lastUpdate = new Date();
    } catch {
      this.relayConnected = false;
    }
  }

  /** Démarre le polling du relais (10 s, visibility-aware). Idempotent. */
  connectRelay() {
    if (this.#relayTimer || typeof document === 'undefined') return;
    this.refreshRelay();
    this.#relayTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refreshRelay();
    }, 10_000);
    this.#relayVis = () => {
      if (document.visibilityState === 'visible') this.refreshRelay();
    };
    document.addEventListener('visibilitychange', this.#relayVis);
  }

  disconnectRelay() {
    if (this.#relayTimer) {
      clearInterval(this.#relayTimer);
      this.#relayTimer = null;
    }
    if (this.#relayVis) {
      document.removeEventListener('visibilitychange', this.#relayVis);
      this.#relayVis = null;
    }
  }

  /** Allume/éteint le cumulus (Shelly). Optimiste, puis confirmé par relecture. */
  async setRelay(on: boolean) {
    this.relayOn = on; // reflet optimiste immédiat
    try {
      const res = await fetch('/api/cumulus/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      this.relayOn = typeof d.on === 'boolean' ? d.on : on;
      this.relayConnected = true;
    } catch {
      this.refreshRelay(); // resync sur échec
    }
  }

  // ─── Orchestrateur : lecture de l'état + commandes ──────────────
  /** Lecture de l'état du moteur (mode, raison, énergie réelle, anomalie, config). */
  async refreshOrchestrator() {
    try {
      const res = await fetch('/api/cumulus/orchestrator', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const s = d?.state;
      if (s) {
        if (s.autoMode === 'auto' || s.autoMode === 'manual' || s.autoMode === 'off')
          this.autoMode = s.autoMode;
        if (typeof s.lastReason === 'string') this.decisionReason = s.lastReason;
        if (typeof s.lastSubMode === 'string') this.decisionSubMode = s.lastSubMode;
        if (typeof s.anomaly === 'string') this.anomaly = s.anomaly;
        this.lastTickTs = typeof s.lastTickTs === 'number' ? s.lastTickTs : null;
        this.waterTempC = typeof s.lastTempC === 'number' ? s.lastTempC : null;
        this.ballonCharged = !!s.ballonCharged;
        this.boostUntilFull = !!s.boostUntilFull;
        this.disinfectLastTs = typeof s.lastDisinfectTs === 'number' ? s.lastDisinfectTs : null;
        // L'énergie réelle (delta compteur EM-50) remplace le mock.
        if (typeof s.energyTodayKwh === 'number')
          this.energyTodayKwh = +s.energyTodayKwh.toFixed(2);
        // Réserve d'eau (E_avail) — lecture seule, observation.
        const en = s.energy;
        this.eAvailWh = typeof en?.eAvailWh === 'number' ? en.eAvailWh : null;
        this.lastAnchorTs = typeof en?.lastAnchorTs === 'number' ? en.lastAnchorTs : null;
        const ev = s.energyView;
        this.eFullWh = typeof ev?.eFullWh === 'number' ? ev.eFullWh : null;
        this.showers = typeof ev?.showers === 'number' ? ev.showers : null;
        const pl = s.plan;
        this.plan =
          pl && typeof pl.action === 'string'
            ? {
                action: pl.action,
                reason: typeof pl.reason === 'string' ? pl.reason : '',
                targetHour: typeof pl.targetHour === 'number' ? pl.targetHour : null,
                showers: typeof pl.showers === 'number' ? pl.showers : 0,
                floorShowers: typeof pl.floorShowers === 'number' ? pl.floorShowers : 0,
                deficitWh: typeof pl.deficitWh === 'number' ? pl.deficitWh : 0,
                pvCoverW: typeof pl.pvCoverW === 'number' ? pl.pvCoverW : 0,
                batteryCoverW: typeof pl.batteryCoverW === 'number' ? pl.batteryCoverW : 0,
                gridDrawW: typeof pl.gridDrawW === 'number' ? pl.gridDrawW : 0,
                autoconsoPct: typeof pl.autoconsoPct === 'number' ? pl.autoconsoPct : 0,
                costNowEur: typeof pl.costNowEur === 'number' ? pl.costNowEur : 0,
                costHcEur: typeof pl.costHcEur === 'number' ? pl.costHcEur : 0,
                backstopHcHour: typeof pl.backstopHcHour === 'number' ? pl.backstopHcHour : null,
                computedAt: typeof pl.computedAt === 'number' ? pl.computedAt : 0
              }
            : null;
        this.shadowLog = Array.isArray(s.shadowLog) ? s.shadowLog : [];
      }
      if (d?.config) this.config = d.config as CumulusConfigClient;
      this.orchestratorConnected = true;
      this.lastUpdate = new Date();
    } catch {
      this.orchestratorConnected = false;
    }
  }

  /** Démarre le polling de l'orchestrateur (20 s, visibility-aware). Idempotent. */
  connectOrchestrator() {
    if (this.#orchTimer || typeof document === 'undefined') return;
    this.refreshOrchestrator();
    this.#orchTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refreshOrchestrator();
    }, 20_000);
    this.#orchVis = () => {
      if (document.visibilityState === 'visible') this.refreshOrchestrator();
    };
    document.addEventListener('visibilitychange', this.#orchVis);
  }

  disconnectOrchestrator() {
    if (this.#orchTimer) {
      clearInterval(this.#orchTimer);
      this.#orchTimer = null;
    }
    if (this.#orchVis) {
      document.removeEventListener('visibilitychange', this.#orchVis);
      this.#orchVis = null;
    }
  }

  async #postCommand(body: {
    autoMode?: CumulusAutoMode;
    manualRelayOn?: boolean;
    boost?: boolean;
  }) {
    try {
      const res = await fetch('/api/cumulus/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const d = await res.json();
        if (typeof d.relayOn === 'boolean') this.relayOn = d.relayOn;
      }
    } catch {
      // l'optimisme reste ; le prochain refresh réconcilie
    }
    this.refreshOrchestrator();
  }

  /** Change le mode de pilotage (auto / manuel / vacances). Optimiste. */
  async setAutoMode(mode: CumulusAutoMode) {
    this.autoMode = mode;
    await this.#postCommand({ autoMode: mode });
  }

  /** Force le relais (bascule implicitement en mode manuel). Optimiste. */
  async setManualRelay(on: boolean) {
    this.relayOn = on;
    this.autoMode = 'manual';
    await this.#postCommand({ manualRelayOn: on });
  }

  /** Lance (ou arrête) une chauffe « à la demande », jusqu'au plein. Optimiste. */
  async setBoost(on: boolean) {
    this.boostUntilFull = on;
    if (on) this.autoMode = 'auto';
    await this.#postCommand({ boost: on });
  }

  /** Met à jour la config du moteur (PUT /api/cumulus/config), renvoie la version effective. */
  async saveConfig(partial: Partial<CumulusConfigClient>) {
    try {
      const res = await fetch('/api/cumulus/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(partial)
      });
      if (res.ok) this.config = (await res.json()) as CumulusConfigClient;
    } catch {
      // silencieux : l'UI garde la valeur saisie, le prochain refresh réconcilie
    }
  }
}

export const cumulus = new CumulusState();
