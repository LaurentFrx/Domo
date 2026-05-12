<script lang="ts">
  import type { SolcastStore } from '$lib/forecast/solcast.svelte';

  interface Props {
    solcast: SolcastStore;
  }

  const { solcast }: Props = $props();

  /**
   * Énergie prévue pour la journée de demain (minuit local → minuit suivant).
   * On reste en heure locale : c'est ce que l'utilisateur perçoit comme "demain".
   */
  const tomorrowEnergyKwh = $derived.by(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return solcast.points.reduce((acc, p) => {
      const t = new Date(p.time).getTime();
      if (t > start.getTime() && t <= end.getTime()) {
        return acc + (p.pvEstimate * p.periodSeconds) / 3600;
      }
      return acc;
    }, 0);
  });

  /**
   * Agrégation des points 30 min en buckets horaires sur les 24 prochaines
   * heures, pour le mini bar chart. Moyenne kW par heure ≈ kWh sur 1h.
   */
  const hourlyBars = $derived.by(() => {
    const horizonHours = 24;
    const buckets: { sum: number; count: number }[] = Array.from(
      { length: horizonHours },
      () => ({ sum: 0, count: 0 })
    );
    const now = Date.now();
    for (const p of solcast.points) {
      const t = new Date(p.time).getTime();
      const hoursAhead = Math.floor((t - now) / (3600 * 1000));
      if (hoursAhead >= 0 && hoursAhead < horizonHours) {
        buckets[hoursAhead].sum += p.pvEstimate;
        buckets[hoursAhead].count += 1;
      }
    }
    return buckets.map((b) => (b.count > 0 ? b.sum / b.count : 0));
  });

  const maxBarKw = $derived(Math.max(0.5, ...hourlyBars));
  const maxBarHeight = 50;

  function barOpacity(value: number, max: number): number {
    if (max === 0) return 0.3;
    const ratio = value / max;
    return ratio < 0.3 ? 0.3 + ratio : 1.0;
  }

  function handleRefresh(): void {
    void solcast.forceRefresh();
  }

  const hasData = $derived(solcast.points.length > 0);
  const showError = $derived(!!solcast.lastError && !hasData);
  const showEmpty = $derived(!hasData && !solcast.isLoading && !solcast.lastError);
  const showSkeleton = $derived(solcast.isLoading && !hasData);
</script>

<div
  class="relative overflow-hidden rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5"
>
  <!-- Glow vert décoratif, identique à CumulusTile -->
  <div
    class="pointer-events-none absolute h-36 w-36 rounded-full bg-[var(--accent-500)] opacity-10 blur-2xl"
    style="top: -50px; right: -40px;"
  ></div>

  <div class="relative flex flex-col gap-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">
        PRÉVISION SOLAIRE
      </span>
      {#if solcast.isLoading && hasData}
        <span class="text-[10px] text-[var(--text-secondary)]">maj…</span>
      {/if}
    </div>

    {#if showSkeleton}
      <!-- Loading : skeleton minimaliste -->
      <div class="flex flex-col gap-3">
        <div class="h-10 w-2/3 animate-pulse rounded-md bg-white/10"></div>
        <div class="h-[50px] w-full animate-pulse rounded-md bg-white/5"></div>
      </div>
    {:else if showError}
      <div class="flex flex-col gap-2">
        <span class="text-sm text-[var(--error)]">Prévision indisponible.</span>
        <span class="text-[11px] text-[var(--text-secondary)]">{solcast.lastError}</span>
        <button
          type="button"
          onclick={handleRefresh}
          class="mt-1 self-start rounded-full border border-[var(--border-default)] px-3 py-1 text-xs text-white hover:bg-white/5"
        >
          Réessayer
        </button>
      </div>
    {:else if showEmpty}
      <div class="flex flex-col items-start gap-2">
        <span class="text-sm text-[var(--text-secondary)]">Aucune donnée chargée.</span>
        <button
          type="button"
          onclick={handleRefresh}
          class="rounded-full border border-[var(--border-default)] px-3 py-1 text-xs text-white hover:bg-white/5"
        >
          Rafraîchir
        </button>
      </div>
    {:else}
      <!-- Valeur principale "Demain : X.X kWh prévus" -->
      <div class="flex items-baseline gap-2">
        <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">
          DEMAIN
        </span>
        <span class="text-5xl font-light text-[var(--accent-500)]">
          {tomorrowEnergyKwh.toFixed(1)}
        </span>
        <span class="text-lg font-light text-[var(--text-secondary)]">kWh prévus</span>
      </div>

      <!-- Mini bar chart horaire 24h -->
      <div class="flex items-end gap-1" style="height: {maxBarHeight}px;">
        {#each hourlyBars as v, i (i)}
          <div
            class="flex-1 rounded-full"
            style="
              background-color: var(--accent-500);
              opacity: {barOpacity(v, maxBarKw)};
              height: {Math.max(4, (v / maxBarKw) * maxBarHeight)}px;
            "
          ></div>
        {/each}
      </div>

      <div class="flex justify-between text-[9px] text-[var(--text-secondary)]">
        <span>Maintenant</span>
        <span>+12h</span>
        <span>+24h</span>
      </div>
    {/if}
  </div>
</div>
