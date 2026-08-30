/**
 * Ventilation mensuelle énergie/économies — lecture seule de la base du
 * domo-recorder. Alimente le « Tableau mensuel » de la page Énergie (12 mois
 * d'une année), en remplacement des valeurs mockées.
 *
 * Sources, agrégées par mois et fusionnées :
 *  · enedis_daily (compteur Linky J+1 via MyElectricalData, backfillé 36 mois)
 *    → import CANONIQUE, fusionné PAR JOUR avec savings_daily (le jour courant
 *    n'existe qu'en mesure maison) ; les relevés mensuels saisis gardent le
 *    dernier mot sur la ventilation HC/HP.
 *  · savings_daily (déjà DATÉE Paris + intégrée HP/HC + gaps gérés par le
 *    recorder) → autoconso_kwh (wh_hp+wh_hc), import_kwh (import_wh),
 *    savings_eur (eur_hp+eur_hc). Mêmes chiffres que /api/savings et la
 *    SavingsCard → aucune contradiction sur la page.
 *  · em50_daily (compteur LOCAL, intégré à la minute) → prime sur le cloud pour
 *    l'import ET l'export, jour par jour ; sa ventilation HC/HP est reconstruite
 *    depuis `pv_samples.em50_grid_w` pour les mois pas encore relevés.
 *  · pv_samples (puissance brute, epoch UTC) → production_kwh (∫ production_w)
 *    et surplus_kwh (∫ grid_export_w), intégrés à la volée (trapèze + plafond de
 *    gap 600 s, identique au recorder). Groupage par mois UTC (le serveur tourne
 *    en UTC ; l'écart de bord Paris < 2 h est négligeable sur un total mensuel).
 *
 * Baseline (économies acquises AVANT le recorder, cf. tariffs.ts) : repliée dans
 * le mois courant tant qu'on est dans le mois d'ancrage — exactement comme la
 * SavingsCard — pour que la cellule « mois courant » du tableau == l'héro.
 *
 * Robustesse (calquée sur /api/savings) : DB absente / verrouillée / illisible →
 * 503 + 12 mois à ZÉRO, jamais de crash. Readonly d'abord, repli rw. Tables pas
 * encore créées (DB neuve) → zéros en 200. Connexion toujours refermée.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Database from 'better-sqlite3';
import {
  anchorMonthBaseline,
  isHC,
  monthlyImportHcHistory,
  monthlyImportHpHistory,
  monthlySavingsHistory,
  parisDate,
  regimeAt
} from '$lib/server/tariffs';
import type { RequestHandler } from './$types';

/** D'où vient la ventilation HC/HP d'un mois, du plus fiable au moins fiable :
 * `curve` = courbe de charge ½h Enedis (la MESURE, ventilée à la minute par le
 * recorder — canonique) ; `meter` = relevé compteur saisi à la main dans
 * tariffs.json ; `enedis` = total Linky mais répartition estimée du ratio
 * EM-50 ; `local` = total ET répartition estimés. `null` = rien de connu.
 * Exposé pour que la carte n'affiche pas une estimation comme une mesure. */
type SplitSource = 'curve' | 'meter' | 'local' | 'enedis' | null;

interface MonthAgg {
  production_kwh: number;
  autoconso_kwh: number;
  surplus_kwh: number;
  import_kwh: number;
  import_hc_kwh: number;
  import_hp_kwh: number;
  /** Import RÉELLEMENT MESURÉ ce mois par le recorder (savings_daily), AVANT tout
   * remplacement par un relevé compteur mensuel. Cohérent en période avec
   * autoconso_kwh → base du KPI d'autosuffisance (≠ import_kwh, qui privilégie le
   * relevé facturé pour le tableau). */
  import_live_kwh: number;
  import_split_source: SplitSource;
  savings_eur: number;
  /** Vrai quand autoconso_kwh est RECONSTRUIT depuis les € importés de HA
   * (pré-recorder, juin 2025 → mai 2026) : kWh = € / tarif HP du régime —
   * l'autoconso solaire se fait quasi exclusivement en HP (les HC sont
   * 00:06-08:06, la nuit). L'UI hachure ces mois. */
  autoconso_estimated: boolean;
}

interface MonthlyPayload {
  year: number;
  months: MonthAgg[]; // toujours 12 entrées, index 0 = janvier
  min_year: number; // première année disposant de données (borne du sélecteur)
  /** Plus gros MOIS DE CONSO (import + autoconso, estimée incluse) toutes
   * années confondues : l'échelle FIXE du graphe Saisons — les hauteurs
   * restent comparables d'une année à l'autre. */
  scale_max_kwh: number;
  /** Vrai quand la courbe ½h n'a pas encore été récupérée pour cette année mais
   * que le backfill y descend (il remonte le temps semaine par semaine, freiné
   * par le quota Enedis) : l'UI dit « en cours » plutôt que « pas de données ». */
  curve_pending: boolean;
}

function zeroMonth(): MonthAgg {
  return {
    production_kwh: 0,
    autoconso_kwh: 0,
    surplus_kwh: 0,
    import_kwh: 0,
    import_hc_kwh: 0,
    import_hp_kwh: 0,
    import_live_kwh: 0,
    import_split_source: null,
    savings_eur: 0,
    autoconso_estimated: false
  };
}

function emptyMonths(): MonthAgg[] {
  return Array.from({ length: 12 }, zeroMonth);
}

/** Replie la baseline du MOIS D'ANCHOR (part pré-recorder du mois où le recorder a
 * démarré) dans la cellule de CE mois-là — de façon PERMANENTE, pas seulement le
 * mois où on s'y trouve. Le mois d'anchor est un mois split (ex. juin 2026 :
 * 1→5 pré-recorder = baseline.month_eur, 5→30 = savings_daily) ; sans ce report,
 * la cellule perd la part pré-recorder dès qu'on passe au mois suivant (juin
 * retombait de ~102 € à 89,47 €). N'affecte que l'année de l'anchor. Le total de
 * l'année du tableau recolle alors à /api/savings.year (source de vérité). */
function foldBaseline(months: MonthAgg[], year: number): void {
  const a = anchorMonthBaseline();
  if (!a || a.year !== year) return;
  months[a.monthIndex].savings_eur += a.eur;
  months[a.monthIndex].autoconso_kwh += a.kwh; // 0 aujourd'hui (month_kwh=0), mais correct
}

/** Cache mémoire des ratios HC/HP dérivés (cf. localHcShare). Quelques entrées au
 * plus : une par jeu de mois non relevés d'une année consultée. */
const shareCache = new Map<string, { at: number; shares: Map<number, number> }>();
const SHARE_TTL_MS = 10 * 60_000;

/** Cache des intégrales pv_samples (production/surplus par mois UTC).
 *
 * pv_samples est APPEND-ONLY (~2 500 lignes/jour) : un mois révolu ne change
 * plus jamais. Or l'intégrale annuelle (window function sur toute la table de
 * l'année) coûtait ~0,5 s par appel — et better-sqlite3 étant synchrone dans
 * l'unique process Node, TOUT le serveur gelait à chaque poll de la page
 * Énergie (5 min), pour recalculer des mois immuables. Ici : les mois clos
 * sont intégrés UNE fois par vie du process (`upTo` = début du mois courant
 * UTC, invalide le gel au changement de mois), seul le mois courant est
 * réintégré à chaque appel, sur sa propre fenêtre (≤ 31 j de lignes).
 * Un backfill qui réécrirait des mois passés exige un restart du service. */
const pvCache = new Map<number, { upTo: number; prod: number[]; surp: number[] }>();

/** Part « mois courant » de l'intégrale (recalculée, elle) : TTL court — fin de
 * mois, sa fenêtre atteint ~145 ms ; le poll est à 5 min et plusieurs clients
 * la partagent, 60 s de fraîcheur suffisent à un tableau mensuel. */
const pvLiveCache = new Map<number, { at: number; rows: ReturnType<typeof pvIntegrateRange> }>();
const PV_LIVE_TTL_MS = 60_000;

/** Intégrale trapèze production/surplus par mois UTC sur [a, b) (epoch s) —
 * même requête que l'historique : gap plafonné 600 s, MAX(0,·) sur l'export
 * (colonne ajoutée après coup : NULL anciens + 3 valeurs legacy à −12 W). */
function pvIntegrateRange(
  db: Database.Database,
  a: number,
  b: number
): { m: number; production_kwh: number; surplus_kwh: number }[] {
  if (b <= a) return [];
  return db
    .prepare(
      'WITH d AS (' +
        " SELECT CAST(strftime('%m', ts, 'unixepoch') AS INTEGER) AS m," +
        '  ts - LAG(ts) OVER (ORDER BY ts) AS dt,' +
        '  (production_w + LAG(production_w) OVER (ORDER BY ts))/2.0 AS avg_prod,' +
        '  (MAX(0.0,COALESCE(grid_export_w,0))' +
        '   + MAX(0.0,COALESCE(LAG(grid_export_w) OVER (ORDER BY ts),0)))/2.0 AS avg_exp' +
        '  FROM pv_samples WHERE ts >= ? AND ts < ?' +
        ') SELECT m,' +
        ' COALESCE(SUM(CASE WHEN dt>0 AND dt<=600 THEN avg_prod*dt/3600.0 END),0)/1000.0 AS production_kwh,' +
        ' COALESCE(SUM(CASE WHEN dt>0 AND dt<=600 THEN avg_exp*dt/3600.0 END),0)/1000.0 AS surplus_kwh' +
        ' FROM d WHERE m IS NOT NULL GROUP BY m'
    )
    .all(a, b) as { m: number; production_kwh: number; surplus_kwh: number }[];
}

/**
 * Taille de bucket d'intégration (s) alignée sur les frontières HC du régime, et
 * son décalage. But : qu'aucun bucket ne CHEVAUCHE une bascule HP/HC — sinon son
 * énergie serait classée en bloc du mauvais côté.
 *
 * Les fenêtres réelles (00:06 → 08:06) tombent à 6 min de l'heure ronde ; comme
 * les décalages Paris↔UTC sont des heures entières, un bucket de 30 min décalé
 * de 360 s cale EXACTEMENT sur les deux bascules, été comme hiver. Si les
 * fenêtres du régime ne partagent pas ce reste (config exotique), on rétrograde
 * à 60 s : toujours exact, juste plus de lignes à agréger.
 */
function bucketing(t: Date): { sizeS: number; offsetS: number } {
  const wins = regimeAt(t).hc_windows ?? [];
  const bounds = wins.flat();
  const rests = bounds.map((hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return ((h || 0) * 3600 + (m || 0) * 60) % 1800;
  });
  const same = rests.length > 0 && rests.every((r) => r === rests[0]);
  return same ? { sizeS: 1800, offsetS: rests[0] } : { sizeS: 60, offsetS: 0 };
}

/**
 * Ventilation HC/HP de l'import réseau DÉRIVÉE de la mesure locale, par mois.
 *
 * Pourquoi : la ventilation ne venait QUE des relevés compteur mensuels saisis à
 * la main (tariffs.json) → le mois en cours n'avait jamais de barre, et l'année
 * affichée sous-comptait de tous les mois pas encore relevés. Or l'EM-50
 * échantillonne le réseau signé (`pv_samples.em50_grid_w`, ~30 s) : l'heure de
 * chaque échantillon suffit à le classer HP/HC via le régime tarifaire.
 *
 * On n'en tire que le RATIO, jamais des kWh : l'EM-50 est une intégration
 * d'instantanés, qui sous-compte l'import de ~23 % contre Enedis (validé sur
 * l'export du 30/06/2026). L'appelant applique ce ratio au total de
 * `savings_daily` — l'EM-50 dit la FORME de la journée, pas son niveau.
 *
 * RÉSERVE assumée : rien ne garantit que ce sous-comptage soit réparti à
 * l'identique entre HC et HP (il vient des appels brefs, plus fréquents en
 * journée) — le ratio penche donc probablement un peu trop vers HC. D'où
 * `import_split_source = 'local'` et le marquage « estimé » sur la carte. Seule
 * la courbe ½h Enedis lèvera le doute (cf. intégration MyElectricalData).
 *
 * `wanted` restreint le scan aux mois qui en ont besoin (ceux sans relevé) : la
 * fenêtre window-function sur pv_samples grossit d'~500 k lignes par an, inutile
 * de la balayer en entier pour ventiler le seul mois courant.
 *
 * Retour : index de mois (0-11) → part HC dans [0,1]. Mois absent = pas de mesure.
 */
function localHcShare(db: Database.Database, year: number, wanted: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (wanted.length === 0) return out;

  // Cache : le balayage coûte ~0,5 s (window function sur ~50 k échantillons par
  // mois) contre ~2 ms pour tout le reste de l'endpoint, et le poll revient
  // toutes les 5 min. Un ratio HP/HC bouge de quelques dixièmes de point par
  // jour : le recalculer à chaque appel ne rapporte rien.
  const key = `${year}:${wanted.join(',')}`;
  // Année révolue : les échantillons ne bougent plus, le ratio est FIGÉ — pas de
  // TTL, le scan (~0,3 s, synchrone donc bloquant) ne se paie qu'une fois.
  const frozen = year < Number(parisDate(new Date()).slice(0, 4));
  const hit = shareCache.get(key);
  if (hit && (frozen || Date.now() - hit.at < SHARE_TTL_MS)) return hit.shares;

  const { sizeS, offsetS } = bucketing(new Date(Date.UTC(year, 6, 1)));
  const first = Math.min(...wanted);
  const last = Math.max(...wanted);
  const yStart = Math.floor(Date.UTC(year, first, 1) / 1000) - 7200; // marge de bord Paris
  const yEnd = Math.floor(Date.UTC(year, last + 1, 1) / 1000) + 7200;

  let rows: { bucket: number; wh: number }[];
  try {
    rows = db
      .prepare(
        'WITH d AS (' +
          ' SELECT ts, ts - LAG(ts) OVER (ORDER BY ts) AS dt,' +
          '  (MAX(0.0,em50_grid_w) + MAX(0.0,LAG(em50_grid_w) OVER (ORDER BY ts)))/2.0 AS avg_imp' +
          '  FROM pv_samples WHERE em50_grid_w IS NOT NULL AND ts >= ? AND ts < ?' +
          ') SELECT (ts - ?) / ? AS bucket,' +
          ' COALESCE(SUM(CASE WHEN dt>0 AND dt<=600 THEN avg_imp*dt/3600.0 END),0) AS wh' +
          ' FROM d GROUP BY bucket HAVING wh > 0'
      )
      .all(yStart, yEnd, offsetS, sizeS) as { bucket: number; wh: number }[];
  } catch {
    return out; // colonne em50_grid_w absente (base pré-EM-50)
  }

  // Accumulation par mois PARIS (le bord de mois UTC diffère de 1-2 h) × tranche.
  const hc = new Array<number>(12).fill(0);
  const hp = new Array<number>(12).fill(0);
  for (const r of rows) {
    if (!Number.isFinite(r.wh) || r.wh <= 0) continue;
    // Milieu du bucket : à l'abri d'un arrondi de bord dans les deux classements.
    const mid = new Date((r.bucket * sizeS + offsetS + sizeS / 2) * 1000);
    const day = parisDate(mid);
    if (day.slice(0, 4) !== String(year)) continue;
    const i = Number(day.slice(5, 7)) - 1;
    if (i < 0 || i > 11) continue;
    if (isHC(mid)) hc[i] += r.wh;
    else hp[i] += r.wh;
  }
  for (let i = 0; i < 12; i++) {
    const tot = hc[i] + hp[i];
    if (tot > 1) out.set(i, hc[i] / tot); // > 1 Wh : ignore le bruit d'un mois vide
  }
  shareCache.set(key, { at: Date.now(), shares: out });
  return out;
}

export const GET: RequestHandler = async ({ url }) => {
  const now = new Date();
  const curYear = Number(parisDate(now).slice(0, 4));
  const yReq = Number(url.searchParams.get('year'));
  const year =
    Number.isFinite(yReq) && yReq >= 2000 && yReq <= curYear + 1 ? Math.trunc(yReq) : curYear;

  const path = env.RECORDER_DB_PATH;
  if (!path) {
    return json(
      { year, months: emptyMonths(), error: 'RECORDER_DB_PATH non configurée' },
      { status: 503 }
    );
  }

  let db: Database.Database | null = null;
  try {
    // readonly d'abord ; repli rw si l'ouverture readonly coince (cf. history /
    // savings). Dans tous les cas on n'exécute QUE des SELECT.
    try {
      db = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      db = new Database(path, { readonly: false, fileMustExist: true });
    }
    db.pragma('busy_timeout = 5000');

    const months = emptyMonths();

    // ── savings_daily (Paris) : autoconso / import / économies par mois ──
    const hasSavings = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='savings_daily'")
      .get();
    if (hasSavings) {
      const rows = db
        .prepare(
          'SELECT CAST(substr(date,6,2) AS INTEGER) AS m,' +
            ' COALESCE(SUM(wh_hp+wh_hc),0)/1000.0 AS autoconso_kwh,' +
            ' COALESCE(SUM(import_wh),0)/1000.0 AS import_kwh,' +
            ' COALESCE(SUM(eur_hp+eur_hc),0) AS savings_eur' +
            ' FROM savings_daily WHERE substr(date,1,4) = ? GROUP BY m'
        )
        .all(String(year)) as {
        m: number;
        autoconso_kwh: number;
        import_kwh: number;
        savings_eur: number;
      }[];
      for (const r of rows) {
        const i = r.m - 1;
        if (i >= 0 && i < 12) {
          months[i].autoconso_kwh = Math.max(0, r.autoconso_kwh);
          months[i].import_kwh = Math.max(0, r.import_kwh);
          months[i].savings_eur = Math.max(0, r.savings_eur);
        }
      }
    }

    // ── NE PAS faire primer l'EM-50 sur le NIVEAU d'import ──
    // Tentation naturelle (le compteur local semble plus « vrai » que le cloud),
    // mais l'export Enedis du 30/06/2026 a tranché l'inverse sur 17 jours :
    // `em50_daily.import_wh` sous-compte de −23 % (jusqu'à −59 % le 23/06, jour
    // d'incident bridge), quand le proxy compteur-Anker de `savings_daily` colle à
    // −4 %. Une intégration d'instantanés rate les appels brefs ; un compteur
    // cumulé, non. Hiérarchie de l'import : Enedis (canonique, branché 24/08/2026
    // via enedis_daily — cf. bloc ci-dessous)
    // > savings_daily > EM-50, qui ne sert qu'à la FORME intraday (ratio HC/HP
    // ci-dessous). L'EXPORT, lui, reste sur l'EM-50 : le compteur cloud est muet
    // (facteur 6) et Enedis ne publie rien en CACSI.

    // ── pv_samples (UTC) : production / surplus par mois (∫ trapèze, gap ≤ 600 s) ──
    // grid_export_w est NULL sur les anciennes lignes (colonne ajoutée après coup)
    // et porte 3 valeurs legacy à −12 W → MAX(0,·) par échantillon avant le trapèze.
    const yStart = Math.floor(Date.UTC(year, 0, 1) / 1000);
    const yEnd = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
    const hasPv = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pv_samples'")
      .get();
    if (hasPv) {
      // Borne de gel : début du mois courant UTC (le groupage est par mois UTC,
      // cf. en-tête). Année passée → tout gelé ; année future → rien.
      const monthStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
      const frozenUpTo = Math.max(yStart, Math.min(yEnd, monthStartUtc));
      let cached = pvCache.get(year);
      if (!cached || cached.upTo !== frozenUpTo) {
        const prod = new Array<number>(12).fill(0);
        const surp = new Array<number>(12).fill(0);
        for (const r of pvIntegrateRange(db, yStart, frozenUpTo)) {
          const i = r.m - 1;
          if (i >= 0 && i < 12) {
            prod[i] = Math.max(0, r.production_kwh);
            surp[i] = Math.max(0, r.surplus_kwh);
          }
        }
        cached = { upTo: frozenUpTo, prod, surp };
        pvCache.set(year, cached);
      }
      for (let i = 0; i < 12; i++) {
        months[i].production_kwh = cached.prod[i];
        months[i].surplus_kwh = cached.surp[i];
      }
      // Mois courant : réintégré à chaque appel sur SA fenêtre seule. Départ à
      // −610 s (> plafond de gap 600 s) pour retrouver l'intervalle qui
      // chevauche la borne — il appartient au mois de l'échantillon POSTÉRIEUR,
      // exactement comme dans la requête annuelle d'origine ; les lignes du mois
      // précédent ré-embarquées par cette marge sont écartées (m < mois borne).
      // Cas frozenUpTo === yStart (janvier, année future) : pas de marge — elle
      // franchirait la frontière d'année et compterait décembre N−1 dans
      // décembre N (l'original ignorait aussi l'intervalle inter-années).
      if (frozenUpTo < yEnd) {
        const liveStart = frozenUpTo === yStart ? yStart : frozenUpTo - 610;
        const boundaryMonth = new Date(frozenUpTo * 1000).getUTCMonth();
        let live = pvLiveCache.get(year);
        if (!live || Date.now() - live.at >= PV_LIVE_TTL_MS) {
          live = { at: Date.now(), rows: pvIntegrateRange(db, liveStart, yEnd) };
          pvLiveCache.set(year, live);
        }
        for (const r of live.rows) {
          const i = r.m - 1;
          if (i >= boundaryMonth && i < 12) {
            months[i].production_kwh = Math.max(0, r.production_kwh);
            months[i].surplus_kwh = Math.max(0, r.surplus_kwh);
          }
        }
      }
    }

    // ── Surplus : le compteur LOCAL prime sur l'intégrale du signal cloud ──
    // `grid_export_w` vient du snapshot Anker, dont l'export instantané est
    // quasi toujours nul (cache figé) : l'intégrale mesurait 12,2 kWh là où le
    // compteur EM-50 en a compté 77,0 (juin-juillet 2026) — un facteur 6. La
    // table em50_daily est l'intégrale trapèze du compteur local, à la minute.
    // Repli sur l'intégrale cloud pour les mois ANTÉRIEURS à l'EM-50 seulement.
    try {
      const em = db
        .prepare(
          'SELECT CAST(substr(date,6,2) AS INTEGER) AS m, SUM(export_wh)/1000.0 AS kwh' +
            ' FROM em50_daily WHERE substr(date,1,4) = ? GROUP BY m'
        )
        .all(String(year)) as { m: number; kwh: number }[];
      for (const r of em) {
        const i = r.m - 1;
        if (i >= 0 && i < 12 && Number.isFinite(r.kwh)) months[i].surplus_kwh = Math.max(0, r.kwh);
      }
    } catch {
      /* table em50_daily absente (base pré-EM-50) : on garde l'intégrale cloud */
    }

    // ── Économies importées de HA (pré-recorder) ──
    // Comble savings_eur des mois SANS ligne enregistrée (tous antérieurs à
    // l'ancrage du recorder → aucun recouvrement). N'affecte que la colonne € ;
    // les kWh restent à 0 (« — »), ce détail n'a pas été importé. Déjà comptées
    // dans les totaux via la baseline → purement d'affichage ici.
    const history = monthlySavingsHistory();
    for (let i = 0; i < 12; i++) {
      if (months[i].savings_eur >= 0.005) continue; // donnée enregistrée : on la garde
      const v = history[`${year}-${String(i + 1).padStart(2, '0')}`];
      if (typeof v === 'number' && v > 0) months[i].savings_eur = v;
    }

    // ── Autoconso PRÉ-RECORDER reconstruite (parc en service juin 2025, recorder
    // né juin 2026) : HA ne nous a légué que des € par mois (tariffs.json) — les
    // kWh sont reconstruits par le tarif évité : kWh = € / HP du régime
    // (l'autoconso solaire vit en HP ; la fenêtre HC 00:06-08:06 est nocturne).
    // Marquée `autoconso_estimated` → hachures côté UI, jamais vendue comme une
    // mesure. Ne touche pas import_live ni le KPI du mois courant (mesuré). ──
    for (let i = 0; i < 12; i++) {
      if (months[i].autoconso_kwh >= 1) continue; // mesuré par le recorder : on garde
      const eur = history[`${year}-${String(i + 1).padStart(2, '0')}`];
      if (typeof eur !== 'number' || eur <= 0) continue;
      const hp = regimeAt(new Date(Date.UTC(year, i, 15))).hp_eur_kwh;
      if (hp > 0) {
        months[i].autoconso_kwh = eur / hp;
        months[i].autoconso_estimated = true;
      }
    }

    // Import « live » = ce que le recorder a effectivement mesuré ce mois
    // (savings_daily), AVANT tout remplacement par un relevé compteur mensuel
    // ci-dessous. Base du KPI d'autosuffisance, cohérent en période avec l'autoconso.
    for (let i = 0; i < 12; i++) months[i].import_live_kwh = months[i].import_kwh;

    // ── enedis_daily (Linky J+1 via MyElectricalData) : l'import CANONIQUE ──
    // Fusion PAR JOUR et non par mois : Enedis publie à J+1, donc le jour courant
    // n'existe jamais côté compteur — un total mensuel purement Enedis perdrait
    // 1 à 3 jours du mois en cours. Jour par jour : Enedis s'il existe, sinon la
    // mesure maison (savings_daily, qui sous-compte d'~18 % — validé le 24/08 sur
    // 7 j croisés). Vient APRÈS la copie import_live_kwh (qui doit RESTER la
    // mesure maison, cohérente en période avec l'autoconso pour le KPI) et AVANT
    // les relevés mensuels saisis, qui gardent le dernier mot ('meter').
    const enedisDominant = new Set<number>();
    try {
      const eRows = db
        .prepare(
          'SELECT date, soutirage_kwh AS kwh FROM enedis_daily' +
            ' WHERE substr(date,1,4) = ? AND soutirage_kwh IS NOT NULL'
        )
        .all(String(year)) as { date: string; kwh: number }[];
      if (eRows.length > 0) {
        const sByDay = new Map<string, number>();
        if (hasSavings) {
          const sRows = db
            .prepare(
              'SELECT date, import_wh/1000.0 AS kwh FROM savings_daily WHERE substr(date,1,4) = ?'
            )
            .all(String(year)) as { date: string; kwh: number }[];
          for (const r of sRows) sByDay.set(r.date, Math.max(0, r.kwh));
        }
        const enedisKwh = new Array<number>(12).fill(0);
        const fallbackKwh = new Array<number>(12).fill(0);
        const eDays = new Set<string>();
        for (const r of eRows) {
          const i = Number(r.date.slice(5, 7)) - 1;
          if (i < 0 || i > 11 || !Number.isFinite(r.kwh)) continue;
          eDays.add(r.date);
          enedisKwh[i] += Math.max(0, r.kwh);
        }
        for (const [day, kwh] of sByDay) {
          const i = Number(day.slice(5, 7)) - 1;
          if (i < 0 || i > 11 || eDays.has(day)) continue;
          fallbackKwh[i] += kwh;
        }
        for (let i = 0; i < 12; i++) {
          if (enedisKwh[i] <= 0) continue; // mois sans compteur : comportement d'avant
          months[i].import_kwh = enedisKwh[i] + fallbackKwh[i];
          // La ventilation dérivée (plus bas) marquera 'enedis' si l'essentiel
          // des kWh du mois vient du compteur (mois courant : tout sauf ~1 jour).
          if (enedisKwh[i] >= fallbackKwh[i]) enedisDominant.add(i);
        }
      }
    } catch {
      /* table enedis_daily absente (base d'avant l'intégration) */
    }

    // ── Ventilation HC/HP RÉELLE (courbe ½h Enedis, câblée le 25/08/2026) ──
    // enedis_daily.hc_kwh/hp_kwh sont remplis par le recorder depuis la courbe de
    // charge, découpée à la minute sur les fenêtres HC du régime (les bascules
    // 00:06/08:06 ne tombent pas sur des bords de demi-heure — le recorder
    // répartit au prorata). C'est LA mesure : elle prime sur tout, y compris sur
    // les relevés saisis (qui couvrent des périodes de facturation, pas des mois
    // civils — d'où l'écart de juin 2026 : 7,8 kWh saisis contre 26,6 mesurés).
    // Couverture du mois par la courbe (le backfill remonte le temps peu à peu) :
    //  · ≥ 95 % des kWh → 'curve', la ventilation est la MESURE ;
    //  · 40 à 95 %      → on l'affiche quand même, en appliquant la répartition
    //    des jours connus au total du mois, mais marquée 'enedis' — l'UI la met
    //    alors en italique avec la mention « répartition estimée » ;
    //  · < 40 %         → trop peu pour dire quoi que ce soit, on laisse la
    //    chaîne d'estimation EM-50 ci-dessous faire son travail.
    const curveMonths = new Set<number>();
    try {
      const rows = db
        .prepare(
          'SELECT CAST(substr(date,6,2) AS INTEGER) AS m,' +
            ' SUM(hc_kwh) AS hc, SUM(hp_kwh) AS hp,' +
            ' SUM(CASE WHEN hc_kwh IS NULL THEN soutirage_kwh ELSE 0 END) AS missing' +
            ' FROM enedis_daily WHERE substr(date,1,4) = ? GROUP BY m'
        )
        .all(String(year)) as { m: number; hc: number; hp: number; missing: number }[];
      for (const r of rows) {
        const i = r.m - 1;
        const covered = (r.hc || 0) + (r.hp || 0);
        if (i < 0 || i > 11 || covered <= 0) continue;
        const part = covered / (covered + Math.max(0, r.missing || 0));
        if (part < 0.4) continue;
        // Normalise sur le total du mois (qui peut inclure des jours de repli
        // mesure-maison, ou ceux que la courbe n'a pas encore couverts) pour que
        // HC + HP == import_kwh, toujours.
        const k = months[i].import_kwh > 0 ? months[i].import_kwh / covered : 1;
        months[i].import_hc_kwh = r.hc * k;
        months[i].import_hp_kwh = r.hp * k;
        months[i].import_split_source = part >= 0.95 ? 'curve' : 'enedis';
        curveMonths.add(i);
      }
    } catch {
      /* colonnes hc_kwh/hp_kwh absentes (base d'avant la courbe ½h) */
    }

    // ── Imports réseau relevés au compteur, ventilés HC / HP (pré-recorder) ──
    // Relevés Linky/EDF (= facturés) → source de vérité. Quand un mois a un relevé,
    // il PRIME sur le recorder (≠ logique des économies) : le recorder ne ventile
    // pas l'import HP/HC, et ses chiffres du mois COURANT sont moins fiables (ex.
    // juin 2026, données HA erronées). import_kwh = HC + HP. Les mois SANS relevé
    // gardent le total recorder (sans ventilation → HC/HP restent à 0).
    const importHc = monthlyImportHcHistory();
    const importHp = monthlyImportHpHistory();
    const noMeter: number[] = [];
    for (let i = 0; i < 12; i++) {
      if (curveMonths.has(i)) continue; // la mesure ½h a déjà tranché
      const key = `${year}-${String(i + 1).padStart(2, '0')}`;
      const hc = importHc[key];
      const hp = importHp[key];
      const hasHc = typeof hc === 'number' && hc > 0;
      const hasHp = typeof hp === 'number' && hp > 0;
      if (hasHc || hasHp) {
        // ⚠️ Un relevé saisi couvre une PÉRIODE DE FACTURATION, pas un mois
        // civil : juillet 2025 portait 13,6 kWh quand le compteur en a compté
        // 91,8 sur les 31 jours (bug visible en prod le 25/08/2026). Le relevé
        // ne donne donc QUE la répartition Creuses/Pleines — un ratio, appliqué
        // au total Enedis, qui reste seul maître du volume. Il ne fait le total
        // que si Enedis n'a rien pour ce mois (avant l'historique Linky).
        const relHc = hasHc ? hc : 0;
        const relHp = hasHp ? hp : 0;
        const relTot = relHc + relHp;
        if (months[i].import_kwh > 0 && relTot > 0) {
          const shareHc = relHc / relTot;
          months[i].import_hc_kwh = months[i].import_kwh * shareHc;
          months[i].import_hp_kwh = months[i].import_kwh * (1 - shareHc);
        } else {
          months[i].import_hc_kwh = relHc;
          months[i].import_hp_kwh = relHp;
          months[i].import_kwh = relTot;
        }
        months[i].import_split_source = 'meter';
      } else if (months[i].import_kwh > 0) {
        noMeter.push(i); // candidat à la ventilation dérivée (cf. ci-dessous)
      }
    }

    // Ventilation de repli, dérivée de la mesure locale (cf. localHcShare) : elle
    // couvre les mois SANS relevé — dont le mois en cours, qui restait vide sur la
    // carte HC/HP jusqu'à la saisie du relevé, un mois plus tard. Ratio local
    // appliqué au total mesuré : seul le ratio est fiable, pas ses kWh bruts.
    const hcShare = localHcShare(db, year, noMeter);
    for (const i of noMeter) {
      const share = hcShare.get(i);
      if (share === undefined) continue;
      const tot = months[i].import_kwh;
      months[i].import_hc_kwh = tot * share;
      months[i].import_hp_kwh = tot * (1 - share);
      months[i].import_split_source = enedisDominant.has(i) ? 'enedis' : 'local';
    }

    // ── Borne basse du sélecteur d'année : première année avec des données ──
    // (économies importées OU lignes savings_daily). Repli : année courante.
    let minYear = curYear;
    for (const k of [...Object.keys(history), ...Object.keys(importHc), ...Object.keys(importHp)]) {
      const y = Number(k.slice(0, 4));
      if (Number.isFinite(y) && y >= 2000 && y < minYear) minYear = y;
    }
    if (hasSavings) {
      const r = db.prepare('SELECT MIN(substr(date,1,4)) AS y FROM savings_daily').get() as {
        y: string | null;
      };
      const y = Number(r?.y);
      if (Number.isFinite(y) && y >= 2000 && y < minYear) minYear = y;
    }

    try {
      const r = db.prepare('SELECT MIN(substr(date,1,4)) AS y FROM enedis_daily').get() as {
        y: string | null;
      };
      const y = Number(r?.y);
      if (Number.isFinite(y) && y >= 2000 && y < minYear) minYear = y;
    } catch {
      /* table enedis_daily absente */
    }

    // ── Échelles FIXES toutes années confondues (demande Laurent 24/08) : le
    // graphe Saisons et la carte HC/HP gardent la même échelle d'une année à
    // l'autre — un mois d'hiver 2024 et un été 2026 se comparent d'un regard.
    // Conso du mois = import (max des sources par mois : Enedis, recorder,
    // relevé saisi) + autoconso (mesurée ou reconstruite HA). Léger (agrégats
    // sur ~1 100 lignes), pas de cache nécessaire. ──
    let scaleMaxKwh = 0;
    {
      const importYm = new Map<string, number>();
      const autoYm = new Map<string, number>();
      const bump = (map: Map<string, number>, ym: string, v: number) => {
        if (Number.isFinite(v)) map.set(ym, Math.max(map.get(ym) ?? 0, v));
      };
      try {
        for (const r of db
          .prepare(
            'SELECT substr(date,1,7) AS ym, SUM(soutirage_kwh) AS kwh FROM enedis_daily GROUP BY ym'
          )
          .all() as { ym: string; kwh: number }[])
          bump(importYm, r.ym, r.kwh);
      } catch {
        /* table absente */
      }
      if (hasSavings) {
        for (const r of db
          .prepare(
            'SELECT substr(date,1,7) AS ym, SUM(import_wh)/1000.0 AS imp,' +
              ' SUM(wh_hp+wh_hc)/1000.0 AS auto FROM savings_daily GROUP BY ym'
          )
          .all() as { ym: string; imp: number; auto: number }[]) {
          bump(importYm, r.ym, r.imp);
          bump(autoYm, r.ym, r.auto);
        }
      }
      for (const [ym, hc] of Object.entries(importHc)) {
        const hp = importHp[ym];
        bump(importYm, ym, (typeof hc === 'number' ? hc : 0) + (typeof hp === 'number' ? hp : 0));
      }
      for (const [ym, eur] of Object.entries(history)) {
        if ((autoYm.get(ym) ?? 0) >= 1 || typeof eur !== 'number' || eur <= 0) continue;
        const hp = regimeAt(new Date(`${ym}-15T12:00:00Z`)).hp_eur_kwh;
        if (hp > 0) bump(autoYm, ym, eur / hp);
      }
      for (const [ym, imp] of importYm)
        scaleMaxKwh = Math.max(scaleMaxKwh, imp + (autoYm.get(ym) ?? 0));
      for (const [ym, auto] of autoYm)
        if (!importYm.has(ym)) scaleMaxKwh = Math.max(scaleMaxKwh, auto);
    }

    foldBaseline(months, year);

    // Le backfill de la courbe descend du présent vers le passé : une année
    // entièrement située AVANT le curseur est simplement en attente.
    let curvePending = false;
    try {
      const r = db
        .prepare('SELECT curve_backfill_cursor AS c FROM enedis_state WHERE id=1')
        .get() as { c: string | null } | undefined;
      // Le curseur pointe la prochaine tranche à récupérer : toute année à sa
      // hauteur ou en dessous reste à couvrir.
      const cur = r?.c;
      curvePending = !!cur && String(year) <= cur.slice(0, 4);
    } catch {
      /* colonne absente : on reste sur « pas de données » */
    }

    const payload: MonthlyPayload = {
      year,
      months,
      min_year: minYear,
      scale_max_kwh: scaleMaxKwh,
      curve_pending: curvePending
    };
    return json(payload);
  } catch (e) {
    // Détail en log serveur SEULEMENT (un message SQLite peut exposer un chemin interne).
    console.error('[energy/monthly] DB error:', e instanceof Error ? e.message : e);
    // DB absente / verrouillée / illisible → 503 + 12 mois ZÉRO, jamais de crash.
    return json({ year, months: emptyMonths(), error: 'database_unavailable' }, { status: 503 });
  } finally {
    try {
      db?.close();
    } catch {
      /* connexion déjà fermée / jamais ouverte : on ignore */
    }
  }
};
