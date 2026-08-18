/**
 * PROJECTIONS — la maison simulée, rendue dans la forme attendue par chaque API.
 *
 * Un seul modèle physique (maison.ts), autant de vues qu'il y a d'endpoints.
 * Chaque projection se contente de traduire l'état de l'instant dans le contrat
 * réel de la route : mêmes noms de champs, mêmes unités, mêmes conventions de
 * signe. Les formes ont été relevées sur l'installation en service, pas
 * devinées — un contrat inventé casserait silencieusement le store côté client.
 *
 * FERMÉ PAR DÉFAUT : ce qui n'est pas ici n'est PAS servi depuis le réel. Le
 * hook renvoie « indisponible ». C'est la propriété qui garantit qu'une démo ne
 * peut pas laisser filtrer une donnée de la vraie maison, même si j'oublie un
 * endpoint.
 */
import { etatMaison, type EtatMaison } from './maison.ts';

/** Cumul de production depuis la mise en service (kWh) — ordre de grandeur réel. */
const LIFETIME_APS_KWH = 1406.6;
const LIFETIME_ANKER_KWH = 2042.0;

const HP_EUR = 0.2318;
const HC_EUR = 0.1812;

const BATTERIES = [
  { id: 'demo-maxac', nom: 'Solix Max AC', modele: 'A17C5-MAX', capaciteWh: 7100 },
  { id: 'demo-sb3-1', nom: 'Solarbank 3 E2700 Pro', modele: 'A17C5', capaciteWh: 2700 },
  { id: 'demo-sb3-2', nom: 'Solarbank 3 E2700 Pro', modele: 'A17C5', capaciteWh: 2700 }
];

/** Répartit une puissance de parc sur les batteries, au prorata des capacités. */
function partage(total: number, i: number): number {
  const somme = BATTERIES.reduce((s, b) => s + b.capaciteWh, 0);
  return Math.round((total * BATTERIES[i].capaciteWh) / somme);
}

function heureParis(ts: number): number {
  const [h, m] = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(ts)
    .split(':')
    .map(Number);
  return h + m / 60;
}

const enHC = (ts: number) => heureParis(ts) >= 0.1 && heureParis(ts) < 8.1;

type Projection = (e: EtatMaison) => unknown;

/**
 * Table des projections. La clé est le chemin EXACT de la route ; les routes à
 * paramètre ne sont pas simulées (elles renverront « indisponible »).
 */
export const PROJECTIONS: Record<string, Projection> = {
  '/api/anker/status': (e) => ({
    connected: true,
    last_update: Math.floor(e.ts / 1000),
    solar_power_w: e.pvW,
    grid_power_w: e.reseauW,
    daily_production_wh: e.productionJourWh,
    daily_consumption_wh: e.consommationJourWh,
    self_consumption_rate: e.productionJourWh > 0 ? 0.97 : null,
    lifetime_production_kwh: LIFETIME_ANKER_KWH,
    lifetime_savings_eur: Math.round(LIFETIME_ANKER_KWH * HP_EUR),
    battery_charge_power_w: e.batterieChargeW,
    battery_discharge_power_w: e.batterieDechargeW,
    sb_output_power_w: e.sortieAcW,
    batteries: BATTERIES.map((b, i) => ({
      id: b.id,
      name: b.nom,
      model: b.modele,
      soc: e.batterieSoc,
      charging_power_w: partage(e.batterieChargeW, i),
      discharging_power_w: partage(e.batterieDechargeW, i),
      output_power_w: partage(e.sortieAcW, i),
      input_power_w: partage(e.pvW, i),
      mode: 'self_consumption',
      temperature_c: 24,
      battery_capacity_wh: b.capaciteWh,
      battery_energy_wh: Math.round((b.capaciteWh * e.batterieSoc) / 100),
      status: 'online'
    })),
    smart_meter: {
      id: 'demo-meter',
      name: 'Compteur',
      model: 'A17X7',
      grid_power_w: e.reseauW,
      status: 'online'
    },
    sites: [{ id: 'demo-site', name: 'Maison' }],
    // Cumuls Linky : seule source fiable côté réel, on garde la convention.
    grid_import_today_kwh: Math.round((e.consommationJourWh / 1000) * 0.02 * 100) / 100,
    grid_export_today_kwh: Math.round((e.productionJourWh / 1000) * 0.04 * 100) / 100
  }),

  '/api/anker-local/status': (e) => ({
    solarbank: {
      available: true,
      soc_pct: e.batterieSoc,
      battery_power_w: e.batterieChargeW > 0 ? -e.batterieChargeW : e.batterieDechargeW,
      ac_power_w: e.sortieAcW,
      ac_net_w: e.sortieAcW - e.batterieChargeW,
      pv_power_w: Math.round(e.pvW * 0.68),
      load_power_w: 0,
      battery_status:
        e.batterieChargeW > 0 ? 'charging' : e.batterieDechargeW > 0 ? 'discharging' : 'idle',
      mode: 'self_consumption',
      mode_raw: 0,
      rated_energy_wh: 7100,
      energy_wh: Math.round((7100 * e.batterieSoc) / 100)
    },
    meter: { available: true, grid_power_w: e.reseauW, voltage_v: 234 },
    em50_grid_w: e.reseauW
  }),

  '/api/apsystems/status': (e) => ({
    available: true,
    power_w: e.onduleurW,
    p1_w: Math.round(e.onduleurW / 2),
    p2_w: Math.round(e.onduleurW / 2),
    today_kwh: Math.round((e.productionJourWh / 1000) * 0.32 * 1000) / 1000,
    lifetime_kwh: LIFETIME_APS_KWH,
    ts: Math.floor(e.ts / 1000),
    min_power_w: 30,
    max_power_limit_w: 960,
    max_power_w: 960,
    write_enabled: true,
    cap_lease: { active: false, cap_w: null, ttl_s: 600, expires_in_s: null }
  }),

  '/api/em50/status': (e) => ({
    available: true,
    grid_power_w: e.reseauW,
    grid_voltage_v: 234.8,
    grid_import_kwh: 47.9,
    grid_export_kwh: 113.7,
    cumulus_power_w: e.ballonW,
    cumulus_current_a: Math.round((e.ballonW / 234.8) * 100) / 100,
    cumulus_kwh: 195.8,
    ts: Math.floor(e.ts / 1000)
  }),

  '/api/sb3loop/status': (e) => ({
    enabled: true,
    autoDisabledReason: null,
    autoDisabledTs: null,
    lastCmdW: e.sortieAcW,
    lastWriteTs: e.ts - 4 * 60_000,
    lastTickTs: e.ts,
    confirmFailCount: 0,
    decisions: []
  }),

  '/api/apsloop/status': (e) => ({
    enabled: true,
    observationMode: false,
    lastObs: { gridW: e.reseauW, apsW: e.onduleurW, ts: e.ts },
    autoDisabledReason: null,
    confirmFailCount: 0,
    lastTickTs: e.ts,
    lastWriteTs: e.ts - 6 * 60_000,
    lastCmdW: e.onduleurW,
    loop: { capW: 960, active: false },
    log: []
  }),

  '/api/cumulus/relay': (e) => ({ available: true, on: e.ballonAllume, power_w: e.ballonW }),

  '/api/cumulus/orchestrator': (e) => ({
    state: {
      autoMode: 'auto',
      relayOn: e.ballonAllume,
      waterTempC: e.ballonC,
      lastDecisionTs: e.ts,
      lastReason: e.ballonAllume
        ? enHC(e.ts)
          ? 'chauffe heures creuses — cible 07:15'
          : 'surplus solaire réorienté vers le ballon'
        : e.ballonC > 55
          ? 'ballon plein'
          : 'attente de surplus',
      startsToday: 1,
      eAvailWh: Math.round((e.ballonC - 15) * 348),
      showers: Math.round(((e.ballonC - 40) * 348) / 2000)
    },
    config: { setpointC: 59, heatPowerW: 2900, tankWhPerC: 348 }
  }),

  '/api/airzone/status': (e) => ({
    available: true,
    mode: 'cooling',
    zones: ['Parents', 'Amis', 'Bureau'].map((nom, i) => ({
      id: i + 1,
      name: nom,
      on: false,
      setpoint: 24,
      room_temp: e.pieces[nom],
      humidity: 58
    }))
  }),

  '/api/daikin/status': (e) => ({
    available: true,
    units: [
      {
        id: 'demo-daikin',
        name: 'Séjour',
        power: false,
        operationMode: 'cooling',
        roomTemperature: e.pieces['Séjour'],
        outdoorTemperature: e.exterieurC,
        setpoint: 24
      }
    ]
  }),

  '/api/thermostat/status': (e) => ({
    connected: true,
    last_update: e.ts,
    room_temp_c: e.pieces['Salle de bain'],
    humidity: 62,
    outdoor_temp_c: e.exterieurC,
    switch_on: false,
    switch_available: true,
    duty_cycle: 0,
    active_preset: 'frost',
    target_temp_c: 7,
    mode: 'auto',
    override: null,
    reason: null,
    next_transition: null
  }),

  '/api/weather': (e) => ({
    current: {
      temperature_c: e.exterieurC,
      cloud_cover: Math.round(e.cielCouvert * 100),
      wind_kmh: Math.round(8 + e.cielCouvert * 14)
    },
    forecast3d: [0, 1, 2].map((j) => {
      const midi = etatMaison(e.ts + j * 86_400_000);
      return {
        day: j,
        t_min_c: Math.round(midi.exterieurC - 7),
        t_max_c: Math.round(midi.exterieurC + 3)
      };
    })
  }),

  '/api/forecast': (e) => {
    const hourly = Array.from({ length: 24 }, (_, i) => {
      const t = e.ts + i * 3_600_000;
      return { ts: Math.floor(t / 1000), w: etatMaison(t).pvW };
    });
    return {
      model: 'AROME (démonstration)',
      last_update: Math.floor(e.ts / 1000),
      fresh: true,
      count: hourly.length,
      next_24h_kwh: Math.round((hourly.reduce((s, h) => s + h.w, 0) / 1000) * 10) / 10,
      hourly
    };
  },

  '/api/tariffs/current': (e) => ({
    period: enHC(e.ts) ? 'HC' : 'HP',
    price_eur_kwh: enHC(e.ts) ? HC_EUR : HP_EUR,
    next: { period: enHC(e.ts) ? 'HP' : 'HC', at: null }
  }),

  '/api/savings': (e) => {
    const kwh = e.productionJourWh / 1000;
    return {
      today: {
        eur: Math.round(kwh * HP_EUR * 100) / 100,
        eur_hp: Math.round(kwh * HP_EUR * 0.96 * 100) / 100,
        eur_hc: Math.round(kwh * HC_EUR * 0.04 * 100) / 100,
        kwh,
        kwh_hp: Math.round(kwh * 0.96 * 100) / 100,
        kwh_hc: Math.round(kwh * 0.04 * 100) / 100,
        rate_eur_h: 0.27,
        coverage_pct: 97.5,
        import_kwh: 0.29,
        export_kwh: 0.57
      },
      month: { eur: 61.1, kwh: 268.3, eur_hp: 57.3, eur_hc: 3.9 },
      year: { eur: 477.2, kwh: 1115.9, eur_hp: 234.4, eur_hc: 19 },
      total: { eur: 752.1, kwh: 1115.9, eur_hp: 234.4, eur_hc: 19 }
    };
  },

  '/api/production/lifetime': () => ({
    available: true,
    apsKwh: LIFETIME_APS_KWH,
    ankerKwh: LIFETIME_ANKER_KWH,
    totalKwh: Math.round((LIFETIME_APS_KWH + LIFETIME_ANKER_KWH) * 100) / 100
  }),

  '/api/health': (e) => ({ mqtt: true, incidents: [], ts: e.ts })
};

/** Réponse simulée pour ce chemin, ou `null` si l'endpoint n'est pas simulé. */
export function projeter(chemin: string, ts = Date.now()): unknown | null {
  const p = PROJECTIONS[chemin];
  return p ? p(etatMaison(ts)) : null;
}
