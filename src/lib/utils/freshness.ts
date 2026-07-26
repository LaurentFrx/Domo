/**
 * Fraîcheur d'une source de données — MÉCANISME UNIQUE de l'app.
 *
 * Le mode de défaillance que ce module existe pour tuer : une source meurt et
 * l'interface continue d'afficher sa dernière valeur comme si elle était vivante.
 * Isabelle lit « 2,7 kW » à 3 h du matin et n'a aucun moyen de savoir que plus
 * rien ne répond depuis six heures.
 *
 * TROIS états, parce que deux ne suffisent pas : effacer un chiffre au premier
 * poll raté ferait clignoter les cartes à chaque hoquet Wi-Fi ou réveil de la
 * PWA — plus personne ne ferait confiance à l'app ; ne l'effacer jamais, c'est
 * la panne muette. L'état intermédiaire achète les deux.
 *
 *   frais  → rien de particulier à l'écran (le nominal ne s'orne d'aucun badge)
 *   retard → la valeur reste, désaturée, avec son âge en clair
 *   mort   → la valeur DISPARAÎT (« — ») et les contrôles se désactivent
 *
 * FRAÎCHEUR MATÉRIELLE, JAMAIS CELLE DU PROXY : quand un bridge expose
 * l'horodatage de sa mesure, c'est lui qu'il faut passer en `tsMs`, pas l'heure
 * du dernier fetch — celle-ci continue d'avancer alors même que le bridge
 * ressert un cache mort. Le store `airzone` le fait déjà (`bridgeUpdate`), c'est
 * le modèle. Conséquence utile : pour apsystems et em50, dont le `ts` vient du
 * bridge, un fetch raté laisse le snapshot intact donc l'âge grandit tout seul —
 * aucun compteur d'échecs n'est nécessaire.
 */

export type Freshness = 'frais' | 'retard' | 'mort';

export interface FreshnessInput {
  /** Verdict de la source. `null` = pas encore de réponse (avant le 1er poll) :
   *  on reste optimiste pour ne pas afficher « en panne » au chargement. */
  ok: boolean | null;
  /** Horodatage (ms) de la MESURE, pas du fetch. `null` si la source n'en
   *  expose pas — on retombe alors sur le seul verdict `ok`. */
  tsMs: number | null;
  /** Cadence NOMINALE de la source (ms). Jamais la cadence boostée : un boost
   *  ne doit pas rendre la carte plus nerveuse. */
  refreshMs: number;
  /** Horloge passée explicitement → réactif dans Svelte, et testable sans
   *  faux timer. */
  now: number;
  /** Cycles manqués avant « retard » / « mort ». Les seuils sont RELATIFS à la
   *  cadence : 3 × 10 s pour l'EM-50 local, 3 × 15 s pour le cloud Anker dont le
   *  cache Solix a déjà ~60 s de mur. Un seuil absolu serait soit trop nerveux
   *  pour le cloud, soit aveugle pour le local. */
  retardAfter?: number;
  mortAfter?: number;
}

const RETARD_CYCLES = 3;
const MORT_CYCLES = 8;
/** Planchers absolus : sous 30 s / 90 s, on juge le réseau, pas la source. */
const RETARD_MIN_MS = 30_000;
const MORT_MIN_MS = 90_000;

export function freshnessOf(i: FreshnessInput): Freshness {
  if (i.ok === null) return 'frais';
  if (i.tsMs === null) return i.ok ? 'frais' : 'mort';

  const age = i.now - i.tsMs;
  const seuilMort = Math.max(MORT_MIN_MS, i.refreshMs * (i.mortAfter ?? MORT_CYCLES));
  const seuilRetard = Math.max(RETARD_MIN_MS, i.refreshMs * (i.retardAfter ?? RETARD_CYCLES));

  // Une source qui répond « non » ET dont la mesure a vieilli est morte plus
  // vite qu'une source simplement silencieuse.
  if (age >= seuilMort || (!i.ok && age >= seuilRetard)) return 'mort';
  if (age >= seuilRetard) return 'retard';
  return i.ok ? 'frais' : 'retard';
}

/**
 * Âge en français courant. Pas de secondes (personne ne lit « il y a 47 s »),
 * pas de décimales, pas de jargon.
 */
export function ageLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "moins d'une minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const j = Math.round(h / 24);
  return j <= 1 ? "plus d'un jour" : `${j} jours`;
}
