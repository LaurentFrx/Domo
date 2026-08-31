/**
 * Store du LABO du critère énergie (page /cumulus-labo).
 *
 * Lit /api/cumulus/criterion : à chaque tick moteur, le bilan du critère
 * (parc / chauffe / soirée / tampon), le verdict des voies historiques et le
 * réel. Polling visibility-aware (pattern printer) : pause en arrière-plan +
 * refetch immédiat au retour de visibilité. Tick moteur ~65 s → sonde à 30 s.
 */

const POLL_MS = 30_000;
const INITIAL_DELAY_MS = 300;

export interface CriterionSample {
  ts: number;
  uParcWh: number | null;
  eChauffeWh: number | null;
  reserveWh: number | null;
  besoinWh: number | null;
  energyOk: boolean;
  legacyOk: boolean;
  commonOk: boolean;
  windowOpen: boolean;
  wantOn: boolean;
  relayOn: boolean;
  heating: boolean;
  /** Cause de la décision du tick (decide) — 'pilot_solar', 'pilot_hc', 'boost'… */
  cause: string;
  gridW: number;
  residualW: number | null;
  /** Critère de rechargeabilité (31/08) : PV prévu restant − maison prévue −
   *  place dans le parc, en Wh. `null` = indécidable. */
  rechargeMarginWh: number | null;
  rechargeOk: boolean | null;
  /** Ce que notre anti-injection retenait à l'onduleur APS (W). */
  apsRecoverableW: number;
}

class CumulusLaboState {
  samples = $state<CriterionSample[]>([]);
  current = $state<CriterionSample | null>(null);
  lastTickTs = $state<number | null>(null);
  status = $state<'idle' | 'polling' | 'ok' | 'error'>('idle');
  lastError = $state<string | null>(null);

  /**
   * Comparaison des voies — corrigée par la revue adversariale du 24/08 :
   *   - fenêtre OUVERTE seulement (la nuit, un parc plein rend energyOk vrai
   *     sans qu'aucune chauffe solaire ne soit possible — bruit pur) ;
   *   - relais OUVERT seulement (pendant une chauffe, energyOk reste vrai tout
   *     du long : compter ces ticks gonflerait « autorisations » d'une heure
   *     par chauffe) ;
   *   - PAS de filtre commonOk : le quota est consommé par les allumages réels,
   *     il aurait masqué les désaccords précisément les jours actifs.
   */
  private comparables = $derived(this.samples.filter((s) => s.windowOpen && !s.relayOn));
  /** Ticks où SEUL le critère énergie aurait autorisé (la valeur ajoutée). */
  energyOnly = $derived(this.comparables.filter((s) => s.energyOk && !s.legacyOk).length);
  /** Ticks où SEULES les voies historiques auraient autorisé (ce qu'on perdrait). */
  legacyOnly = $derived(this.comparables.filter((s) => s.legacyOk && !s.energyOk).length);
  /** Ticks où les deux familles autorisaient. */
  both = $derived(this.comparables.filter((s) => s.legacyOk && s.energyOk).length);
  /**
   * Achat EDF pendant les chauffes SOLAIRES PILOTÉES — le juge de paix.
   * La cause trie ce que le premier jet confondait : une recharge HC achète
   * EXPRÈS au tarif plancher (~3 kW en fin de nuit) et un boost est un ordre
   * de Laurent — ni l'une ni l'autre ne jugent le critère.
   */
  buyDuringHeatWh = $derived(
    Math.round(
      this.samples
        .filter((s) => s.heating && s.cause === 'pilot_solar' && s.gridW > 150)
        .reduce((sum, s) => sum + (s.gridW * 65) / 3600, 0)
    )
  );
  /** Minutes de chauffe solaire pilotée sur la fenêtre chargée. */
  heatMin = $derived(
    Math.round(
      (this.samples.filter((s) => s.heating && s.cause === 'pilot_solar').length * 65) / 60
    )
  );

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  // Jeton de cycle : une chaîne pollAndSchedule dont le jeton n'est plus courant
  // s'arrête au lieu de se ré-armer → aucun timer orphelin si disconnect()
  // survient pendant un fetch en vol (pause visibility-aware exigée par CLAUDE.md).
  private cycle = 0;

  connect() {
    if (typeof window === 'undefined' || this.timerId !== null) return;
    const c = ++this.cycle;
    this.timerId = setTimeout(() => this.pollAndSchedule(c), INITIAL_DELAY_MS);
    this.visibilityHandler = () => {
      if (!document.hidden) this.refresh();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  disconnect() {
    this.cycle++;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.status = 'idle';
  }

  /** Refetch immédiat (retour de visibilité) — repart sur un cycle neuf. */
  refresh() {
    if (typeof window === 'undefined' || document.hidden) return;
    const c = ++this.cycle;
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.timerId = setTimeout(() => this.pollAndSchedule(c), 0);
  }

  private async pollAndSchedule(c: number) {
    this.timerId = null;
    if (c !== this.cycle) return;
    if (!document.hidden) {
      this.status = 'polling';
      try {
        const res = await fetch('/api/cumulus/criterion', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as {
          lastTickTs: number | null;
          current: CriterionSample | null;
          samples: CriterionSample[];
        };
        if (c !== this.cycle) return;
        this.samples = Array.isArray(d.samples) ? d.samples : [];
        this.current = d.current ?? null;
        this.lastTickTs = d.lastTickTs ?? null;
        this.status = 'ok';
        this.lastError = null;
      } catch (e) {
        if (c !== this.cycle) return;
        this.status = 'error';
        this.lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (c !== this.cycle) return;
    this.timerId = setTimeout(() => this.pollAndSchedule(c), POLL_MS);
  }
}

export const cumulusLabo = new CumulusLaboState();
