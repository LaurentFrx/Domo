/**
 * Sondes de santé — détection d'anomalies par source.
 *
 * Tourne dans le process de l'app (appelé par /api/monitor/tick, déclenché par un
 * timer systemd). S'appuie sur `history.db` (sortie du recorder) comme source de
 * vérité PERSISTANTE plutôt que sur des fetchs réseau supplémentaires : le
 * recorder échantillonne déjà toutes les sources énergie toutes les 30 s. On
 * détecte ainsi exactement le mode de panne du 23/06 (APS aveugle en plein jour).
 *
 * Chaque anomalie est portée au bus d'incidents (idempotent par clé). Le retour
 * à la normale RÉSOUT l'incident (et permet de notifier le rétablissement).
 */
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import { isMqttConnected } from '$lib/server/mqtt';
import { raiseIncident, resolveIncident, type RaiseInput, type Severity } from './incidents';

// Seuils (secondes). Le recorder tique ~30 s ; le cloud Solix se rafraîchit ~60 s.
const RECORDER_STALE_S = 240; // > 8 cycles manqués = recorder réellement figé
const APS_WINDOW_S = 900; // 15 min sans APS éveillé en plein jour = aveugle
const EM50_WINDOW_S = 600;
const ANKER_WINDOW_S = 600;
const MIN_SAMPLES = 8; // assez d'échantillons pour conclure (anti-faux positif)
const DAYLIGHT_ELEV_DEG = 5; // soleil franchement levé

export interface ProbeSummary {
  ts: number;
  checked: string[];
  raised: string[];
  resolved: string[];
  recorderStalled: boolean;
  recorderAgeS: number | null;
}

function openDb(): Database.Database | null {
  const path = env.RECORDER_DB_PATH;
  if (!path) return null;
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    try {
      return new Database(path, { readonly: false, fileMustExist: true });
    } catch {
      return null;
    }
  }
}

export function runProbes(): ProbeSummary {
  const s: ProbeSummary = {
    ts: Date.now(),
    checked: [],
    raised: [],
    resolved: [],
    recorderStalled: false,
    recorderAgeS: null
  };

  const assess = (bad: boolean, input: RaiseInput) => {
    s.checked.push(input.source);
    if (bad) {
      if (raiseIncident(input).isNew) s.raised.push(input.key);
    } else if (resolveIncident(input.key)) {
      s.resolved.push(input.key);
    }
  };

  // ── Hub MQTT (capteurs Zigbee, sonde cumulus, portail) ──
  try {
    assess(!isMqttConnected(), {
      key: 'mqtt:down',
      severity: 'warning',
      source: 'mqtt',
      kind: 'unreachable',
      message: 'Hub domotique (MQTT) injoignable — capteurs Zigbee / cumulus / portail hors ligne'
    });
  } catch {
    /* lecture mémoire, ne devrait pas jeter */
  }

  // ── Sources énergie via history.db ──
  const db = openDb();
  if (!db) return s;
  try {
    const nowS = Math.floor(Date.now() / 1000);
    const last = db.prepare('SELECT MAX(ts) AS m FROM pv_samples').get() as { m: number | null };
    if (!last || last.m == null) {
      return s; // base neuve / vide : rien à conclure
    }
    const ageS = nowS - last.m;
    s.recorderAgeS = ageS;

    // 1) Le recorder lui-même est-il vivant ? S'il est figé, les autres sondes
    //    seraient de faux positifs → on traite CE cas et on s'arrête là.
    const recorderBad = ageS > RECORDER_STALE_S;
    s.recorderStalled = recorderBad;
    assess(recorderBad, {
      key: 'recorder:stalled',
      severity: 'critical',
      source: 'recorder',
      kind: 'stalled',
      message: `Enregistreur de données figé (aucune mesure depuis ${Math.round(ageS / 60)} min) — historique & économies suspendus`
    });
    if (recorderBad) return s;

    // Jour/nuit (le recorder écrit l'élévation solaire dans weather_samples).
    const w = db
      .prepare('SELECT sun_elev_deg, is_daylight FROM weather_samples ORDER BY ts DESC LIMIT 1')
      .get() as { sun_elev_deg: number | null; is_daylight: number | null } | undefined;
    const daylight = w ? w.is_daylight === 1 || (w.sun_elev_deg ?? -90) > DAYLIGHT_ELEV_DEG : false;

    // 2) APS aveugle en plein jour (le scénario du 23/06) : sur 15 min, aucun
    //    relevé « éveillé » ET compteur lifetime figé, alors que le soleil est levé.
    const aps = db
      .prepare(
        'SELECT COALESCE(SUM(aps_available),0) AS av, COUNT(*) AS n, ' +
          'COALESCE(MAX(aps_lifetime_kwh),0)-COALESCE(MIN(aps_lifetime_kwh),0) AS dlife ' +
          'FROM pv_samples WHERE ts > ?'
      )
      .get(nowS - APS_WINDOW_S) as { av: number; n: number; dlife: number };
    // En pleine nuit, APS endormi = NORMAL → on résout (pas d'alerte).
    const apsBad = daylight && aps.n >= MIN_SAMPLES && aps.av === 0 && aps.dlife === 0;
    assess(apsBad, {
      key: 'apsystems:blind',
      severity: 'critical',
      source: 'apsystems',
      kind: 'blind',
      message:
        'Onduleur solaire APSystems non lu en plein jour (production = 0, compteur figé) — économies sous-comptées en temps réel'
    });

    // 3) EM-50 (compteur réseau + cumulus) muet : aucune mesure non-nulle.
    const em = db
      .prepare('SELECT COUNT(em50_grid_w) AS c, COUNT(*) AS n FROM pv_samples WHERE ts > ?')
      .get(nowS - EM50_WINDOW_S) as { c: number; n: number };
    assess(em.n >= MIN_SAMPLES && em.c === 0, {
      key: 'em50:down',
      severity: 'warning',
      source: 'em50',
      kind: 'unreachable',
      message: 'Compteur EM-50 (réseau & cumulus) injoignable — mesure temps réel indisponible'
    });

    // 4) Anker Solix muet.
    const an = db
      .prepare(
        'SELECT COALESCE(SUM(sb_available),0) AS av, COUNT(*) AS n FROM pv_samples WHERE ts > ?'
      )
      .get(nowS - ANKER_WINDOW_S) as { av: number; n: number };
    assess(an.n >= MIN_SAMPLES && an.av === 0, {
      key: 'anker:down',
      severity: 'warning',
      source: 'anker',
      kind: 'unreachable',
      message: 'Batterie/onduleur Anker Solix injoignable — répartition solaire incomplète'
    });
  } catch (e) {
    console.error('[monitor] probe DB erreur:', (e as Error).message);
  } finally {
    try {
      db.close();
    } catch {
      /* déjà fermée */
    }
  }
  return s;
}

export type { Severity };
