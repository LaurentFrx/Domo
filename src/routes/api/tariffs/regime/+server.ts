/**
 * Régimes tarifaires — lecture et ÉCRITURE des prix HP/HC.
 *
 * Avant cette route, les 4 champs « Tarifs EDF » des réglages écrivaient dans
 * `data/settings.json` et n'étaient relus par PERSONNE : les prix réellement
 * appliqués (pilote cumulus, économies, ventilation HP/HC) viennent de
 * `data/tariffs.json`, qui n'était éditable qu'à la main sur le serveur. Le
 * panneau était donc un réglage mort.
 *
 * Modèle DATÉ, délibérément conservé : `regimes[]` est une liste de barèmes avec
 * une date d'entrée en vigueur. Un changement de tarif EDF n'invalide pas le
 * passé — les économies déjà calculées doivent continuer d'utiliser le barème en
 * vigueur à l'époque. Écraser le régime courant fausserait tout l'historique,
 * d'où l'ajout d'une nouvelle entrée quand la date diffère.
 *
 * Les fenêtres d'heures creuses ne sont PAS éditables ici : elles changent
 * rarement, une erreur y est coûteuse (elle décale toute la ventilation HP/HC),
 * et leur format `[["HH:MM","HH:MM"]]` wrap-safe se prête mal à un champ de
 * formulaire. Elles restent dans le fichier.
 */
import { json, error } from '@sveltejs/kit';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '$lib/server/atomic-store';
import { regimeAt, parisDate, type TariffRegime } from '$lib/server/tariffs';
import type { RequestHandler } from './$types';

const TARIFFS_FILE = path.resolve(process.cwd(), 'data', 'tariffs.json');

/** Bornes de bon sens (€/kWh). Un tarif réglementé français vit très loin de
 *  ces extrêmes : elles n'existent que pour bloquer une faute de frappe qui
 *  fausserait silencieusement le pilotage du chauffe-eau et les économies. */
const MIN_EUR_KWH = 0.01;
const MAX_EUR_KWH = 2;

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function readRaw(): Record<string, unknown> {
  try {
    statSync(TARIFFS_FILE);
  } catch {
    return {}; // fichier absent (déploiement neuf) : on le créera
  }
  try {
    const parsed = JSON.parse(readFileSync(TARIFFS_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('racine non-objet');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    // Sur des données financières on ne repart JAMAIS d'un fichier vide en
    // silence : écraser un tariffs.json corrompu effacerait la baseline et tout
    // l'historique mensuel des relevés Linky.
    throw error(500, `tariffs.json illisible (${(e as Error).message}) — édition refusée.`);
  }
}

function num(v: unknown, label: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw error(400, `${label} : nombre attendu.`);
  if (n < MIN_EUR_KWH || n > MAX_EUR_KWH) {
    throw error(400, `${label} : ${n} €/kWh hors bornes (${MIN_EUR_KWH}–${MAX_EUR_KWH}).`);
  }
  return n;
}

/** Régime en vigueur + liste complète, pour que l'UI affiche ce qui s'applique. */
export const GET: RequestHandler = () => {
  const now = new Date();
  const raw = readRaw();
  const regimes = Array.isArray(raw.regimes) ? (raw.regimes as TariffRegime[]) : [];
  const cur = regimeAt(now);
  return json({
    today: parisDate(now),
    current: { from: cur.from, hp_eur_kwh: cur.hp_eur_kwh, hc_eur_kwh: cur.hc_eur_kwh },
    hc_windows: cur.hc_windows,
    regimes: regimes.map((r) => ({
      from: r.from,
      hp_eur_kwh: r.hp_eur_kwh,
      hc_eur_kwh: r.hc_eur_kwh
    }))
  });
};

/**
 * Pose un barème à partir d'une date.
 * Corps : `{ from?: 'YYYY-MM-DD', hp_eur_kwh: number, hc_eur_kwh: number }`
 * `from` absent = aujourd'hui (Paris).
 */
export const PUT: RequestHandler = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'JSON invalide');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw error(400, 'objet attendu');
  }
  const b = body as Record<string, unknown>;

  const from = b.from === undefined ? parisDate(new Date()) : String(b.from);
  if (!DATE_RE.test(from)) throw error(400, "Date d'effet attendue au format AAAA-MM-JJ.");
  const hp = num(b.hp_eur_kwh, 'Heures pleines');
  const hc = num(b.hc_eur_kwh, 'Heures creuses');

  const raw = readRaw();
  const regimes: TariffRegime[] = Array.isArray(raw.regimes)
    ? (raw.regimes as TariffRegime[]).slice()
    : [];

  // Fenêtres HC : reprises du régime qui s'applique à cette date, jamais
  // inventées — un nouveau barème hérite des heures creuses en place.
  const base = regimeAt(new Date(`${from}T12:00:00`));
  const entry: TariffRegime = {
    from,
    hp_eur_kwh: hp,
    hc_eur_kwh: hc,
    hc_windows: base.hc_windows
  };

  const at = regimes.findIndex((r) => r.from === from);
  if (at >= 0) regimes[at] = entry;
  else regimes.push(entry);
  regimes.sort((a, b2) => a.from.localeCompare(b2.from));

  // Écriture du fichier ENTIER : `baseline`, `monthly_savings_eur` et les relevés
  // Linky mensuels sont préservés tels quels (ils priment sur le recorder).
  await writeJsonAtomic(TARIFFS_FILE, { ...raw, regimes });

  return json({ ok: true, applied: entry, replaced: at >= 0 });
};
