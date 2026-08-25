/**
 * Les HEURES d'un jour — troisième et dernier niveau du bilan.
 *
 *  · import horaire = table `enedis_curve` (courbe de charge ½h du Linky,
 *    stockée par le recorder). C'est la MESURE, disponible sur tout l'historique
 *    remonté. Convention Enedis respectée : la valeur d'un point couvre
 *    l'intervalle qui PRÉCÈDE son horodatage — le point de 08:00 nourrit donc
 *    l'heure de 07 h, et celui de minuit appartient au jour de la veille ;
 *  · ventilation HC/HP de chaque heure = fenêtres du régime tarifaire, appliquées
 *    à la MINUTE (les bascules 00:06 / 08:06 tombent au milieu d'une heure) ;
 *  · production et autoconso = intégrale de `pv_samples`, donc seulement depuis
 *    juin 2026. Avant, la journée n'a que sa courbe d'import — dit tel quel.
 */
import { json } from '@sveltejs/kit';
import { isHC } from '$lib/server/tariffs';
import {
  emptyBucket,
  hasTable,
  integrateByEdges,
  openDb,
  parisDayStart,
  type Bucket
} from '$lib/server/energy-buckets';
import type { RequestHandler } from './$types';

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const GET: RequestHandler = async ({ url }) => {
  const date = url.searchParams.get('date') ?? '';
  if (!DAY_RE.test(date)) {
    return json(
      { date, hours: [], error: 'paramètre `date` attendu au format YYYY-MM-DD' },
      { status: 400 }
    );
  }

  const db = openDb();
  if (!db) return json({ date, hours: [], error: 'database_unavailable' }, { status: 503 });

  try {
    const start = parisDayStart(date);
    // 25 bornes : le jour du changement d'heure fait 23 ou 25 h — on les calcule
    // par différence plutôt que d'ajouter 3600 aveuglément.
    const next = parisDayStart(new Date((start + 36 * 3600) * 1000).toISOString().slice(0, 10));
    const span = Math.max(3600, next - start);
    const nHours = Math.round(span / 3600);
    const edges: number[] = [];
    for (let i = 0; i <= nHours; i++) edges.push(start + i * 3600);

    const hours: Bucket[] = Array.from({ length: nHours }, (_, i) => {
      const h = new Date((start + i * 3600) * 1000);
      const label = h.toLocaleString('fr-FR', { hour: '2-digit', timeZone: 'Europe/Paris' });
      return emptyBucket(label.replace(':', ' h').replace(/\s*h\s*00$/, ' h'), null);
    });

    // ── Import : courbe ½h Enedis, ventilée HC/HP à la minute ──
    let hasCurve = false;
    if (hasTable(db, 'enedis_curve')) {
      const rows = db
        .prepare('SELECT ts, w, mins FROM enedis_curve WHERE ts > ? AND ts <= ? ORDER BY ts')
        .all(start, start + span) as { ts: number; w: number; mins: number }[];
      for (const r of rows) {
        if (!Number.isFinite(r.w) || r.w < 0 || !r.mins) continue;
        const kwhPerMin = r.w / 60 / 1000;
        // L'intervalle [ts − mins, ts] est découpé minute par minute : chacune
        // tombe dans SON heure et de SON côté de la bascule HC/HP.
        for (let k = 0; k < r.mins; k++) {
          const t = r.ts - r.mins * 60 + k * 60;
          const idx = Math.floor((t - start) / 3600);
          if (idx < 0 || idx >= nHours) continue;
          const b = hours[idx];
          b.import_kwh += kwhPerMin;
          if (isHC(new Date(t * 1000))) b.import_hc_kwh += kwhPerMin;
          else b.import_hp_kwh += kwhPerMin;
          b.import_split_source = 'curve';
          b.empty = false;
          hasCurve = true;
        }
      }
    }

    // ── Production PV + puissance évitée (autoconso), depuis juin 2026 ──
    let hasPv = false;
    if (hasTable(db, 'pv_samples')) {
      const prod = integrateByEdges(db, 'production_w', edges);
      const saved = integrateByEdges(db, 'power_saved_w', edges, true);
      const exported = integrateByEdges(db, 'em50_grid_w', edges, false);
      for (let i = 0; i < nHours; i++) {
        if (prod[i] > 0.0005 || saved[i] > 0.0005) {
          hours[i].production_kwh = Math.max(0, prod[i]);
          hours[i].autoconso_kwh = Math.max(0, saved[i]);
          // em50_grid_w est signé (+ soutirage / − injection) : le surplus est la
          // part négative, que integrateByEdges a intégrée telle quelle.
          hours[i].surplus_kwh = Math.max(0, -exported[i]);
          hours[i].empty = false;
          hasPv = true;
        }
      }
    }

    return json({ date, hours, has_curve: hasCurve, has_pv: hasPv });
  } catch (e) {
    console.error('[energy/hourly] DB error:', e instanceof Error ? e.message : e);
    return json({ date, hours: [], error: 'database_unavailable' }, { status: 503 });
  } finally {
    try {
      db.close();
    } catch {
      /* déjà fermée */
    }
  }
};
