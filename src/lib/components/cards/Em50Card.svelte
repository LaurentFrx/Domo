<script lang="ts">
  /**
   * Carte « Compteur temps réel » — Shelly Pro EM-50 (mesure LOCALE, 2 voies) :
   *   • Réseau EDF : puissance SIGNÉE (soutirage / injection) + tension.
   *   • Cumulus    : puissance instantanée (chauffe / à l'arrêt) + courant.
   *   • Cumuls kWh depuis l'install du compteur (importé / injecté / cumulus).
   *
   * Lit le store em50 (poll visibility-aware, relayé server-side — le device
   * n'est jamais exposé au navigateur). Compteur injoignable → état propre.
   *
   * Style calqué sur les sections de la page énergie (carte verre + tokens
   * sémantiques) ; l'effet « plexiglass » est appliqué automatiquement par
   * src/app.css via le sélecteur [style*='background: var(--color-card)'].
   */
  import { em50 } from '$stores/em50.svelte';
  import { formatPower } from '$utils/format';

  const importing = $derived(em50.gridPowerW > 0); // + = soutirage EDF
  const exporting = $derived(em50.gridPowerW < 0); // − = injection PV
  // Réseau : soutirage = rouge réseau ; injection (surplus) = vert solaire.
  const gridColor = $derived(importing ? 'var(--color-grid-energy)' : 'var(--color-solar)');
</script>

<section
  class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-4"
  class:opacity-60={!em50.available}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <div class="flex items-center justify-between gap-2">
    <span class="text-[14px] font-semibold">Compteur temps réel</span>
    <span
      class="inline-flex items-center gap-1.5 text-[11px]"
      style="color: var(--color-muted-fg);"
    >
      <span
        class="h-1.5 w-1.5 rounded-full"
        style="background: {em50.available ? 'var(--color-solar)' : 'var(--color-muted-fg)'};"
      ></span>
      Shelly EM-50
    </span>
  </div>

  {#if em50.available}
    <div class="grid grid-cols-2 gap-3">
      <!-- Réseau (signé) -->
      <div class="flex flex-col gap-0.5">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Réseau
        </span>
        <span
          class="text-[24px] leading-none font-semibold tabular-nums sm:text-[28px]"
          style="color: {gridColor}; letter-spacing: -0.01em;"
        >
          {importing ? '↓ ' : exporting ? '↑ ' : ''}{formatPower(Math.abs(em50.gridPowerW))}
        </span>
        <span class="text-[12px]" style="color: var(--color-muted-fg);">
          {importing ? 'soutiré du réseau' : exporting ? 'injecté (surplus)' : 'équilibre'} ·
          {em50.gridVoltageV.toFixed(0)} V
        </span>
      </div>

      <!-- Cumulus -->
      <div class="flex flex-col gap-0.5">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Cumulus
        </span>
        <span
          class="text-[24px] leading-none font-semibold tabular-nums sm:text-[28px]"
          style="color: var(--color-consumption); letter-spacing: -0.01em;"
        >
          {formatPower(em50.cumulusPowerW)}
        </span>
        <span class="text-[12px]" style="color: var(--color-muted-fg);">
          {em50.cumulusHeating ? 'en chauffe' : 'à l’arrêt'}{#if em50.cumulusHeating}
            ·
            {em50.cumulusCurrentA.toFixed(1)} A{/if}
        </span>
      </div>
    </div>

    <!-- Cumuls kWh depuis l'install du compteur -->
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2.5 text-[11px]"
      style="color: var(--color-muted-fg); border-color: var(--color-border);"
    >
      <span class="inline-flex items-center gap-1.5">
        <span class="h-1 w-3 rounded-full" style="background: var(--color-grid-energy);"></span>
        Importé {em50.gridImportKwh.toFixed(2)} kWh
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="h-1 w-3 rounded-full" style="background: var(--color-solar);"></span>
        Injecté {em50.gridExportKwh.toFixed(2)} kWh
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="h-1 w-3 rounded-full" style="background: var(--color-consumption);"></span>
        Cumulus {em50.cumulusKwh.toFixed(2)} kWh
      </span>
    </div>
  {:else}
    <p class="text-[12px]" style="color: var(--color-muted-fg);">
      Compteur indisponible (EM-50 injoignable).
    </p>
  {/if}
</section>
