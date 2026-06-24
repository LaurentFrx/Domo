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
// L'onduleur EZ1 s'éteint NORMALEMENT quand ses panneaux ne reçoivent plus assez de
// lumière (nuit, crépuscule, ciel très couvert) — ce n'est PAS un défaut. On ne juge
// donc pas l'APS par la géométrie du soleil (trompeuse au crépuscule) mais par la
// PRODUCTION RÉELLE : le SolarBank (Anker) a ses propres panneaux sous le MÊME soleil.
const SB_SOLAR_MIN_W = 250; // prod solaire Anker « franche » → il y a clairement du soleil
const GHI_MIN_WM2 = 150; // repli (Anker indispo) : irradiance prévue clairement productive

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

    // 2) APS muet ALORS QU'IL Y A DE LA PRODUCTION SOLAIRE (= vrai défaut).
    //    APS muet = jamais éveillé ET compteur figé sur la fenêtre. On n'alerte QUE
    //    si une production solaire est réellement en cours, prouvée par :
    //      · le JUMEAU Anker qui produit franchement (mesure réelle, même soleil) ;
    //      · à défaut (Anker indispo) l'irradiance prévue clairement productive.
    //    La nuit / au crépuscule, l'Anker est à ~0 et le GHI bas → AUCUNE alerte.
    const aps = db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(aps_available),0) AS aps_av, ' +
          'COALESCE(MAX(aps_lifetime_kwh),0)-COALESCE(MIN(aps_lifetime_kwh),0) AS aps_dlife, ' +
          'COALESCE(SUM(sb_available),0) AS sb_n, AVG(CASE WHEN sb_available=1 THEN sb_w END) AS sb_solar ' +
          'FROM pv_samples WHERE ts > ?'
      )
      .get(nowS - APS_WINDOW_S) as {
      n: number;
      aps_av: number;
      aps_dlife: number;
      sb_n: number;
      sb_solar: number | null;
    };
    const wx = db.prepare('SELECT ghi FROM weather_samples ORDER BY ts DESC LIMIT 1').get() as
      | { ghi: number | null }
      | undefined;
    const ghi = wx && typeof wx.ghi === 'number' ? wx.ghi : null;

    const apsDark = aps.n >= MIN_SAMPLES && aps.aps_av === 0 && aps.aps_dlife === 0;
    const ankerUp = aps.sb_n >= MIN_SAMPLES;
    // Priorité à la mesure réelle (Anker) ; l'irradiance ne sert de repli QUE si
    // l'Anker est indisponible (sinon on lui fait confiance, même par ciel couvert).
    const twinProducing = ankerUp && (aps.sb_solar ?? 0) > SB_SOLAR_MIN_W;
    const irradianceHigh = !ankerUp && ghi !== null && ghi > GHI_MIN_WM2;
    const apsBad = apsDark && (twinProducing || irradianceHigh);
    assess(apsBad, {
      key: 'apsystems:blind',
      severity: 'critical',
      source: 'apsystems',
      kind: 'blind',
      message:
        'Onduleur solaire APSystems muet alors que les panneaux produisent — production solaire non comptée (à vérifier)'
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
