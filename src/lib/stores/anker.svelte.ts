/**
 * Anker store — polling REST du microservice anker-bridge sur le RPi4,
 * proxié en HTTPS via Caddy (/anker/api/status).
 *
 * Tant que le .env du bridge ne contient pas ANKER_EMAIL/ANKER_PASSWORD,
 * /api/status renvoie 503 → on garde `connected=false`. Les autres stores
 * (dashboard) basculent alors sur le mock demo-ticker.
 */

import { env } from '$env/dynamic/public';

const PUBLIC_ANKER_URL = env.PUBLIC_ANKER_URL || 'https://domo.feroux.fr/anker';

// Polling client. Le bridge Anker (RPi4) sert un CACHE rafraîchi côté cloud
// Solix toutes les ~60 s (mesuré : last_update figé 63 s puis saut). Poller plus
// vite ne livre PAS de donnée plus fraîche — c'est le mur physique. 15 s = on
// découvre chaque nouvelle mesure cloud avec ≤ 15 s de retard (vs 30 s avant)
// sans marteler le bridge. Le vrai gain de fraîcheur perçue vient du refetch
// immédiat au retour de visibilité (PWA rouverte) + pause en arrière-plan.
const POLL_INTERVAL_MS = 15_000;

export type AnkerBattery = {
  id: string;
  name: string;
  alias: string | null;
  model: string;
  soc: number;
  chargingPowerW: number;
  dischargingPowerW: number;
  outputPowerW: number;
  inputPowerW: number;
  mode: string | null;
  temperatureC: number | null;
  capacityWh: number;
  energyWh: number;
  status: string | null;
};

export type AnkerSmartMeter = {
  id: string;
  name: string | null;
  model: string;
  /** NET de la pince ampèremétrique : + soutirage / − injection (W). SEULE source fiable. */
  gridPowerW: number;
  /**
   * ⚠️ CASSÉ côté bridge Anker — NE JAMAIS UTILISER pour un calcul.
   * Observé en live : net=24 W mais grid_to_home=0 et pv_to_grid=−24 (non conservatif).
   * Le découpage directionnel est faux ; dériver l'import/export du NET :
   *   import = max(0, gridPowerW) · export = max(0, −gridPowerW).
   * Conservés ici par fidélité au payload, mais aucun composant ne doit les lire.
   */
  gridToHomeW: number;
  /** ⚠️ CASSÉ — voir gridToHomeW. Ne jamais utiliser. */
  pvToGridW: number;
  status: string | null;
};

export type AnkerSite = {
  id: string;
  name: string;
};

type ApiPayload = {
  connected: boolean;
  last_update: number | null;
  solar_power_w: number;
  grid_power_w: number;
  daily_production_wh: number;
  daily_consumption_wh: number;
  self_consumption_rate: number | null;
  lifetime_production_kwh?: number;
  lifetime_co2_saved_kg?: number;
  lifetime_savings_eur?: number;
  co2_saved_kg?: number;
  battery_charge_power_w?: number;
  battery_discharge_power_w?: number;
  sb_output_power_w?: number;
  batteries: {
    id: string;
    name: string;
    alias?: string;
    model: string;
    soc: number;
    charging_power_w: number;
    discharging_power_w: number;
    output_power_w?: number;
    input_power_w?: number;
    mode: string | null;
    temperature_c: number | null;
    battery_capacity_wh?: number;
    battery_energy_wh?: number;
    status?: string;
  }[];
  smart_meter: {
    id: string;
    name?: string;
    model: string;
    grid_power_w: number;
    grid_to_home_power_w?: number;
    pv_to_grid_power_w?: number;
    status?: string;
  } | null;
  sites: { id: string; name: string }[];
  /** Cumul JOUR import réseau (kWh) = compteur Linky via cloud (grid_to_home_total). FIABLE. */
  grid_import_today_kwh?: number | null;
  /** Cumul JOUR export réseau (kWh) = compteur Linky via cloud (solar_to_grid_total). FIABLE. */
  grid_export_today_kwh?: number | null;
};

class AnkerState {
  /** Puissance PV totale en Watts. */
  solarPowerW = $state(0);
  /** Puissance réseau BRUTE (net pince) : + soutirage, − injection. Watts. */
  gridPowerW = $state(0);
  /**
   * Réseau FIABLE — dérivé du compteur LINKY, PAS du smart-meter instantané.
   *
   * Le `grid_power_w` instantané du cloud Solix est INEXPLOITABLE : valeurs figées
   * par paliers (246 W bloqué 36 min observé), signe instable, aveugle à l'APS →
   * imports/exports « fantômes » de centaines de W (sur une journée, l'intégrale
   * dépassait 22× la vérité Linky : 2,85 kWh « vus » contre 0,13 réels). On
   * l'IGNORE pour l'affichage.
   *
   * Seule vérité réseau : les cumuls d'énergie du Linky (grid_import/export_today_kwh,
   * via energy_analysis côté bridge), dont on dérive une puissance MOYENNE (ΔWh/Δt).
   * Fiable, au prix d'une granularité ~5 min (cadence du compteur cloud) — sans
   * impact ici, le réseau réel étant quasi nul.
   */
  gridImportW = $state(0);
  gridExportW = $state(0);
  /** Réseau net FIABLE : + soutirage / − injection (W). À utiliser PARTOUT (Sankey, surplus). */
  gridReliableW = $derived(this.gridImportW - this.gridExportW);
  /** Horodatage (s) du snapshot cloud courant (= last_update du bridge), ou null. */
  snapshotTs = $state<number | null>(null);

  /**
   * Flux batterie AGRÉGÉ FIABLE (W), exposé par le bridge depuis solarbank_info
   * (total_photovoltaic_power − total_output_power). Les champs par-unité
   * (charging_power_w…) sont intermittents → on privilégie ces agrégats.
   */
  batteryChargeW = $state(0);
  batteryDischargeW = $state(0);
  /** Sortie AC SolarBank → maison (W), agrégat fiable. */
  sbOutputW = $state(0);

  batteries = $state<AnkerBattery[]>([]);
  smartMeter = $state<AnkerSmartMeter | null>(null);
  sites = $state<AnkerSite[]>([]);

  /**
   * Fraction de la prod PV SolarBank attribuée à l'unité 1 (pan Sud), 0..1.
   * Les `input_power_w` PAR UNITÉ sont INTERMITTENTS (mesuré : souvent 0 pour les
   * deux alors que `solar_power_w` agrégé est correct → un split naïf afficherait
   * 0/0). On mémorise donc le dernier ratio FIABLE (mis à jour seulement quand le
   * par-unité est présent) et on l'applique à l'agrégat fiable. Défaut 0,5
   * (2× SolarBank E2700 Pro, même capacité).
   */
  sb1SolarFraction = $state(0.5);

  /** Production cumulée du jour (Wh) — suspect si égal au lifetime. */
  dailyProductionWh = $state(0);
  /** Consommation estimée du jour (Wh). */
  dailyConsumptionWh = $state(0);
  /** Taux d'autoconsommation 0-100. */
  selfConsumptionRate = $state<number | null>(null);

  /** Production cumulée depuis l'installation (kWh). */
  lifetimeProductionKwh = $state(0);
  /** CO₂ évité depuis l'installation (kg). */
  lifetimeCo2SavedKg = $state(0);
  /** Économies depuis l'installation (€). */
  lifetimeSavingsEur = $state(0);

  lastUpdate = $state<Date | null>(null);
  connected = $state(false);
  status = $state<'idle' | 'polling' | 'connected' | 'unconfigured' | 'error'>('idle');
  lastError = $state<string | null>(null);

  /** SOC moyen des batteries (0-100), ou null si pas de batterie. */
  averageSoc = $derived(
    this.batteries.length === 0
      ? null
      : this.batteries.reduce((s, b) => s + b.soc, 0) / this.batteries.length
  );

  /**
   * Puissance batterie nette : + charge, − décharge (W).
   * Source FIABLE : agrégat bridge (batteryChargeW − batteryDischargeW). Repli sur
   * la somme par-unité seulement si l'agrégat est absent (0) mais qu'une unité bouge.
   */
  netBatteryPowerW = $derived.by(() => {
    const agg = this.batteryChargeW - this.batteryDischargeW;
    if (agg !== 0) return agg;
    return this.batteries.reduce((s, b) => s + b.chargingPowerW - b.dischargingPowerW, 0);
  });

  /**
   * Prod PV (agrégat DC fiable) répartie par unité via le dernier ratio fiable.
   * sb1SolarW → pan Sud (avec l'APS, côté page), sb2SolarW → pan Ouest.
   * Toujours : sb1SolarW + sb2SolarW = solarPowerW (donc total accueil exact).
   */
  sb1SolarW = $derived(this.solarPowerW * this.sb1SolarFraction);
  sb2SolarW = $derived(this.solarPowerW * (1 - this.sb1SolarFraction));

  /** Capacité totale du parc batteries (Wh). */
  totalBatteryCapacityWh = $derived(this.batteries.reduce((s, b) => s + b.capacityWh, 0));

  /** Énergie actuellement stockée (Wh). */
  totalBatteryEnergyWh = $derived(this.batteries.reduce((s, b) => s + b.energyWh, 0));

  /** Statut batterie haut niveau pour le dashboard. */
  batteryStatus = $derived.by<'charge' | 'discharge' | 'idle'>(() => {
    const p = this.netBatteryPowerW;
    if (p > 50) return 'charge';
    if (p < -50) return 'discharge';
    return 'idle';
  });

  /**
   * Heuristique : si daily_production_wh est suspectement proche du lifetime
   * (bug du bridge cloud Anker qui mélange les deux), la valeur du jour est
   * considérée non fiable.
   */
  dailyProductionReliable = $derived.by(() => {
    if (this.lifetimeProductionKwh === 0) return true;
    const dailyKwh = this.dailyProductionWh / 1000;
    return Math.abs(dailyKwh - this.lifetimeProductionKwh) > 0.1;
  });

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;

  // ─── Dérivation réseau depuis les cumuls LINKY (état interne non réactif) ──
  // Le compteur ne fournit qu'un cumul journalier (kWh) rafraîchi ~5 min côté
  // cloud. On en dérive une puissance MOYENNE : ΔWh / Δt entre deux variations du
  // cumul. C'est la SEULE donnée réseau fiable (cf. gridImportW/gridReliableW).
  #imp: { kwh: number | null; ts: number; w: number } = { kwh: null, ts: 0, w: 0 };
  #exp: { kwh: number | null; ts: number; w: number } = { kwh: null, ts: 0, w: 0 };
  // Au-delà de ce délai sans variation du cumul, le flux est considéré arrêté
  // (cadence cloud ~5 min → marge avant de retomber à 0).
  private static readonly GRID_HOLD_MS = 7 * 60_000;

  /** Puissance (W) dérivée d'un cumul d'énergie croissant ; mute `acc` en place. */
  private static rateFrom(
    acc: { kwh: number | null; ts: number; w: number },
    kwh: number | null,
    now: number
  ): number {
    if (kwh == null || !Number.isFinite(kwh)) return acc.w;
    if (acc.kwh === null || kwh < acc.kwh - 1e-4) {
      // 1er point, ou reset minuit (cumul reparti à 0) → ancrer, flux nul.
      acc.kwh = kwh;
      acc.ts = now;
      acc.w = 0;
      return 0;
    }
    if (kwh > acc.kwh + 1e-9) {
      const dtS = Math.max(1, (now - acc.ts) / 1000);
      acc.w = ((kwh - acc.kwh) * 3_600_000) / dtS; // kWh → Wh → W
      acc.kwh = kwh;
      acc.ts = now;
      return acc.w;
    }
    // Cumul plat : on maintient la dernière puissance tant que c'est récent,
    // sinon le flux est réputé arrêté et on ré-ancre la fenêtre.
    if (now - acc.ts > AnkerState.GRID_HOLD_MS) {
      acc.ts = now;
      acc.w = 0;
    }
    return acc.w;
  }

  /** Recalcule gridImportW/gridExportW depuis les cumuls Linky du snapshot. */
  private deriveGridFromLinky(importKwh: number | null, exportKwh: number | null) {
    const now = Date.now();
    this.gridImportW = Math.round(AnkerState.rateFrom(this.#imp, importKwh, now));
    this.gridExportW = Math.round(AnkerState.rateFrom(this.#exp, exportKwh, now));
  }

  connect() {
    if (typeof window === 'undefined') return;
    if (this.visibilityHandler !== null) return; // déjà connecté (layout + pages)
    if (!PUBLIC_ANKER_URL) {
      this.status = 'unconfigured';
      this.lastError = 'PUBLIC_ANKER_URL non défini';
      return;
    }
    // Onglet/PWA en arrière-plan → on suspend le polling (rien à afficher, et on
    // épargne le bridge). Au retour au premier plan → refetch IMMÉDIAT pour une
    // carte à jour dès la réouverture, sans attendre le prochain tick.
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.poll();
        this.startInterval();
      } else {
        this.stopInterval();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.poll();
    this.startInterval();
  }

  disconnect() {
    this.stopInterval();
    if (this.visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private startInterval() {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private stopInterval() {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async poll() {
    this.status = 'polling';
    try {
      const res = await fetch(`${PUBLIC_ANKER_URL}/api/status`, {
        signal: AbortSignal.timeout(15_000)
      });
      if (res.status === 503) {
        this.connected = false;
        this.status = 'unconfigured';
        const body = await res.json().catch(() => ({}));
        this.lastError = (body as { detail?: string }).detail || 'service unavailable';
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as ApiPayload;
      this.applySnapshot(json);
      this.connected = true;
      this.status = 'connected';
      this.lastError = null;
      this.lastUpdate = new Date();
    } catch (e) {
      this.connected = false;
      this.status = 'error';
      this.lastError = (e as Error).message;
    }
  }

  private applySnapshot(p: ApiPayload) {
    this.solarPowerW = p.solar_power_w ?? 0;
    // Brut conservé pour debug uniquement — NE PAS l'afficher (cf. gridReliableW).
    this.gridPowerW = p.grid_power_w ?? 0;
    this.snapshotTs = p.last_update ?? null;
    // Réseau affiché = dérivé des cumuls Linky (seule source fiable).
    this.deriveGridFromLinky(p.grid_import_today_kwh ?? null, p.grid_export_today_kwh ?? null);
    this.dailyProductionWh = p.daily_production_wh ?? 0;
    this.dailyConsumptionWh = p.daily_consumption_wh ?? 0;
    this.selfConsumptionRate = p.self_consumption_rate;
    this.lifetimeProductionKwh = p.lifetime_production_kwh ?? 0;
    this.lifetimeCo2SavedKg = p.lifetime_co2_saved_kg ?? 0;
    this.lifetimeSavingsEur = p.lifetime_savings_eur ?? 0;
    this.batteryChargeW = p.battery_charge_power_w ?? 0;
    this.batteryDischargeW = p.battery_discharge_power_w ?? 0;
    this.sbOutputW = p.sb_output_power_w ?? 0;

    this.batteries = (p.batteries ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      alias: b.alias ?? null,
      model: b.model,
      soc: b.soc,
      chargingPowerW: b.charging_power_w ?? 0,
      dischargingPowerW: b.discharging_power_w ?? 0,
      outputPowerW: b.output_power_w ?? 0,
      inputPowerW: b.input_power_w ?? 0,
      mode: b.mode,
      temperatureC: b.temperature_c,
      capacityWh: b.battery_capacity_wh ?? 0,
      energyWh: b.battery_energy_wh ?? 0,
      status: b.status ?? null
    }));

    // Ratio Sud:Ouest depuis l'input PV par-unité, SEULEMENT quand il est présent
    // (intermittent) ; sinon on conserve le dernier ratio fiable mémorisé.
    const b1 = this.batteries.find((b) => (b.alias ?? '').endsWith('1')) ?? this.batteries[0];
    const b2 = this.batteries.find((b) => (b.alias ?? '').endsWith('2')) ?? this.batteries[1];
    const in1 = b1?.inputPowerW ?? 0;
    const in2 = b2?.inputPowerW ?? 0;
    if (in1 + in2 > 1) this.sb1SolarFraction = in1 / (in1 + in2);

    this.smartMeter = p.smart_meter
      ? {
          id: p.smart_meter.id,
          name: p.smart_meter.name ?? null,
          model: p.smart_meter.model,
          gridPowerW: p.smart_meter.grid_power_w ?? 0,
          gridToHomeW: p.smart_meter.grid_to_home_power_w ?? 0,
          pvToGridW: p.smart_meter.pv_to_grid_power_w ?? 0,
          status: p.smart_meter.status ?? null
        }
      : null;

    this.sites = (p.sites ?? []).map((s) => ({ id: s.id, name: s.name }));
  }
}

export const anker = new AnkerState();
