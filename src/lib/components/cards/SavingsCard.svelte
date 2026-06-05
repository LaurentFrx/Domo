<script lang="ts">
  /**
   * Carte « Économies solaires » — auto-consommation valorisée au tarif HP/HC
   * évité (jour / mois / année / total), lue du store savings (base recorder).
   *
   * `compact` : variante tassée pour l'accueil. Store non connecté → « — » propre
   * (pas de mock). Le débit live (€/h) n'apparaît que s'il est significatif.
   */
  import { savings } from '$stores/savings.svelte';
  import { formatCurrency } from '$utils/format';

  interface Props {
    compact?: boolean;
  }
  let { compact = false }: Props = $props();

  const DASH = '—';
  const eur = (v: number) => formatCurrency(v);

  const connected = $derived(savings.connected);
  const today = $derived(savings.today);
  const month = $derived(savings.month);
  const year = $derived(savings.year);
  const total = $derived(savings.total);

  const rate = $derived(today.rate_eur_h);
  // Seuil : on n'affiche le débit que s'il dépasse ~0,001 €/h (sinon « +0,00 €/h »).
  const showRate = $derived(connected && rate > 0.0005);
  const coverage = $derived(Math.round(today.coverage_pct));
  // Couverture pertinente seulement s'il y a déjà de l'énergie évitée aujourd'hui
  // (sinon « 0 % solaire » la nuit / en début de journée se lit comme un mauvais score).
  const hasCoverage = $derived(connected && today.kwh > 0);
</script>

{#if compact}
  <!-- ═══ Variante compacte (accueil) ═══ -->
  <div
    class="flex flex-col gap-2 rounded-[var(--radius-xl)] border p-4"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex items-center justify-between gap-2">
      <span
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Économies solaires
      </span>
      {#if hasCoverage}
        <span
          class="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.04em]"
          style="background: var(--color-solar-muted); color: var(--color-solar);"
        >
          {coverage}% solaire
        </span>
      {/if}
    </div>

    <div class="flex items-baseline gap-2">
      <span
        class="text-[24px] leading-none font-semibold tabular-nums sm:text-[28px]"
        style="color: var(--color-fg); letter-spacing: -0.01em;"
      >
        {connected ? eur(today.eur) : DASH}
      </span>
      <span class="text-[12px]" style="color: var(--color-muted-fg);">aujourd'hui</span>
      {#if showRate}
        <span
          class="ml-auto text-[12px] font-semibold tabular-nums"
          style="color: var(--color-battery);"
        >
          +{eur(rate)}/h
        </span>
      {/if}
    </div>

    <div
      class="flex items-center justify-between text-[11px] tabular-nums"
      style="color: var(--color-muted-fg);"
    >
      <span
        >Mois <span style="color: var(--color-fg);">{connected ? eur(month.eur) : DASH}</span></span
      >
      <span
        >Année <span style="color: var(--color-fg);">{connected ? eur(year.eur) : DASH}</span></span
      >
      <span
        >Total <span style="color: var(--color-fg);">{connected ? eur(total.eur) : DASH}</span
        ></span
      >
    </div>
  </div>
{:else}
  <!-- ═══ Carte complète (page Énergie) ═══ -->
  <section
    class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="flex flex-col gap-0.5">
        <span class="text-[14px] font-semibold">Économies solaires</span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">
          Auto-consommation valorisée
        </span>
      </div>
    </div>

    <!-- Héro : Aujourd'hui (€) + débit live €/h (mint) -->
    <div class="flex flex-col gap-1">
      <span
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        Aujourd'hui
      </span>
      <div class="flex flex-wrap items-baseline gap-2">
        <span
          class="text-[34px] leading-none font-semibold tabular-nums sm:text-[40px]"
          style="color: var(--color-fg); letter-spacing: -0.02em;"
        >
          {connected ? eur(today.eur) : DASH}
        </span>
        {#if showRate}
          <span class="text-[13px] font-semibold tabular-nums" style="color: var(--color-battery);">
            +{eur(rate)}/h
          </span>
        {/if}
      </div>
    </div>

    <!-- Ligne de 3 : Mois / Année / Total -->
    <div class="grid grid-cols-3 gap-2">
      {#each [{ l: 'Mois', v: month.eur }, { l: 'Année', v: year.eur }, { l: 'Total', v: total.eur }] as cell (cell.l)}
        <div class="flex flex-col gap-0.5">
          <span
            class="text-[10px] font-semibold tracking-[0.06em] uppercase"
            style="color: var(--color-muted-fg);"
          >
            {cell.l}
          </span>
          <span class="text-[16px] font-semibold tabular-nums" style="color: var(--color-fg);">
            {connected ? eur(cell.v) : DASH}
          </span>
        </div>
      {/each}
    </div>

    <!-- Pied : couverture solaire (badge) + ventilation HP/HC -->
    <div class="flex items-center justify-between gap-2">
      <span
        class="rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.04em]"
        style="background: var(--color-solar-muted); color: var(--color-solar);"
      >
        {hasCoverage ? `${coverage}% solaire` : `${DASH} solaire`}
      </span>
      <span
        class="inline-flex items-center gap-2 text-[11px] tabular-nums"
        style="color: var(--color-muted-fg);"
      >
        <span style="color: var(--color-hp);">HP {connected ? eur(today.eur_hp) : DASH}</span>
        <span style="color: var(--color-hc);">HC {connected ? eur(today.eur_hc) : DASH}</span>
      </span>
    </div>
  </section>
{/if}
