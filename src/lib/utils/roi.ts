/**
 * Retour sur investissement (ROI) de l'installation solaire — calcul PUR,
 * partagé par la carte « Économies solaires » (accueil).
 *
 * Coût total = somme des tranches d'installation (Réglages → Bilan). On projette
 * le reste à amortir au taux d'économie RÉALISÉ, décomposé en années/mois/jours
 * + mois/année d'amortissement projeté.
 *
 * Taux retenu = RÉCENT : économies de l'année en cours annualisées → reflète la
 * config actuelle (tranches récentes incluses) au lieu de diluer dans tout
 * l'historique. Repli sur la moyenne depuis la 1ʳᵉ mise en service en tout début
 * d'année (annualiser < ~1,5 mois = trop bruité).
 */

export interface RoiInput {
  /** Coût total de l'installation (€). 0 = non renseigné → pas de ROI. */
  installEur: number;
  /** Date de la 1ʳᵉ mise en service (ISO `YYYY-MM-DD`). */
  firstDateISO: string;
  /** Économies cumulées depuis la mise en service (€). */
  savedTotalEur: number;
  /** Économies de l'année civile en cours (€). */
  yearEur: number;
  /** Instant de référence (injectable pour les tests). */
  now?: Date;
}

export interface RoiView {
  /** false si le coût d'installation n'est pas renseigné. */
  available: boolean;
  /** true une fois l'installation remboursée. */
  amortized: boolean;
  /** Part amortie, 0..100 (entier). */
  amortizedPct: number;
  /** Reste à amortir (€, ≥ 0). */
  remainingEur: number;
  /** Durée restante « 7a 8m 19j » (ou « ✓ » / « — »). */
  label: string;
  /** « mai 2034 » — vide si amorti ou inconnu. */
  payoff: string;
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/** Décompose la durée from→to en années / mois / jours calendaires. */
export function diffYMD(from: Date, to: Date): { y: number; m: number; d: number } {
  let y = to.getFullYear() - from.getFullYear();
  let m = to.getMonth() - from.getMonth();
  let d = to.getDate() - from.getDate();
  if (d < 0) {
    m -= 1;
    d += new Date(to.getFullYear(), to.getMonth(), 0).getDate(); // jours du mois précédent
  }
  if (m < 0) {
    y -= 1;
    m += 12;
  }
  return { y: Math.max(0, y), m: Math.max(0, m), d: Math.max(0, d) };
}

export function computeRoi(input: RoiInput): RoiView {
  const now = input.now ?? new Date();
  const installEur = Number.isFinite(input.installEur) ? input.installEur : 0;
  const saved = Math.max(0, input.savedTotalEur);
  if (installEur <= 0) {
    return {
      available: false,
      amortized: false,
      amortizedPct: 0,
      remainingEur: 0,
      label: '—',
      payoff: ''
    };
  }
  const amortizedPct = Math.min(100, Math.round((100 * saved) / installEur));
  const remainingEur = Math.max(0, installEur - saved);
  const base = { available: true, amortizedPct, remainingEur };
  if (remainingEur <= 0) return { ...base, amortized: true, label: '✓', payoff: '' };

  const first = new Date(input.firstDateISO).getTime();
  const yearsElapsed = Math.max(
    0.1,
    (now.getTime() - (Number.isFinite(first) ? first : now.getTime())) / MS_PER_YEAR
  );
  const avgAnnualEur = saved / yearsElapsed;
  const fracYear = (now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / MS_PER_YEAR;
  const recentAnnualEur =
    fracYear < 0.12 || input.yearEur <= 0 ? avgAnnualEur : input.yearEur / fracYear;
  if (recentAnnualEur <= 0) return { ...base, amortized: false, label: '—', payoff: '' };

  const days = remainingEur / (recentAnnualEur / 365.25);
  const payoffDate = new Date(now.getTime() + days * 24 * 3600 * 1000);
  const { y, m, d } = diffYMD(now, payoffDate);
  const parts: string[] = [];
  if (y > 0) parts.push(`${y}a`);
  if (y > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${d}j`);
  return {
    ...base,
    amortized: false,
    label: parts.join(' '),
    payoff: payoffDate.toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })
  };
}
