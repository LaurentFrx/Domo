<script lang="ts">
  import { ankerLocal } from '$stores/ankerLocal.svelte';

  // Tuile « réseau en local » : contrôle croisé du Smart Meter Gen 2 (Modbus TCP
  // LAN, sans le cloud Solix ni sa latence ~60 s) contre le EM-50. Le EM-50 reste
  // la SOURCE DE VÉRITÉ réseau ; une dérive durable = pince/CT à re-vérifier.
  //
  // Le bloc batterie de cette carte a disparu le 09/08/2026 avec la Solarbank
  // Max AC : le Gen 2 est désormais rattaché aux SB3, qui régulent elles-mêmes.
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  // Écart Gen 2 ↔ EM-50 : au-delà du seuil, on alerte visuellement (même
  // seuil que le log serveur de /api/anker-local/status).
  const DEVIATION_WARN_W = 150;
  const deviationHigh = $derived(
    ankerLocal.gridDeviationW !== null && ankerLocal.gridDeviationW > DEVIATION_WARN_W
  );

  const signed = (w: number) => `${w > 0 ? '+' : ''}${nf0.format(w)} W`;
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-2xl)] border p-4"
  style="background: var(--color-card); border-color: var(--color-border);"
  aria-label="Compteur Anker mesuré en local"
>
  <!-- En-tête -->
  <div class="flex items-start justify-between gap-3">
    <div class="flex flex-col gap-0.5">
      <span class="text-[14px] font-semibold">Réseau · mesure locale</span>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        Smart Meter Gen 2 · lecture directe (sans cloud)
      </span>
    </div>
    {#if ankerLocal.meterAvailable}
      <span
        class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.04em] whitespace-nowrap"
        style="background: var(--color-battery-muted); color: var(--color-battery);"
      >
        <span class="h-1 w-1 rounded-full" style="background: var(--color-battery);"></span>
        {nf0.format(ankerLocal.meterVoltageV)} V
      </span>
    {/if}
  </div>

  {#if ankerLocal.meterAvailable}
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-3">
      <!-- Bloc 1 : réseau signé vu par le Gen 2 -->
      <div class="flex flex-col gap-1.5">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Échange réseau
        </span>
        <div class="flex items-baseline gap-1">
          <span
            class="text-[28px] leading-none font-semibold tabular-nums"
            style="color: {ankerLocal.meterGridPowerW > 25
              ? 'var(--color-hp)'
              : 'var(--color-solar)'}; letter-spacing: -0.01em;"
          >
            {nf0.format(Math.abs(ankerLocal.meterGridPowerW))}
          </span>
          <span class="text-[13px] font-medium" style="color: var(--color-muted-fg);">W</span>
        </div>
        <span class="text-[12px]" style="color: var(--color-muted-fg);">
          {ankerLocal.meterGridPowerW > 25
            ? 'Courant acheté à EDF'
            : ankerLocal.meterGridPowerW < -25
              ? 'Surplus renvoyé au réseau'
              : 'Compteur à l’équilibre'}
        </span>
      </div>

      <!-- Bloc 2 : contrôle croisé (Gen 2 vs EM-50) -->
      <div class="flex flex-col gap-1.5">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Contrôle croisé
        </span>
        <div
          class="flex flex-col gap-0.5 text-[12px] tabular-nums"
          style="color: var(--color-muted-fg);"
        >
          <span class="flex justify-between gap-2">
            <span>Compteur Anker</span>
            <span style="color: var(--color-fg);">{signed(ankerLocal.meterGridPowerW)}</span>
          </span>
          {#if ankerLocal.em50GridW !== null}
            <span class="flex justify-between gap-2">
              <span>Compteur EM-50</span>
              <span style="color: var(--color-fg);">{signed(ankerLocal.em50GridW)}</span>
            </span>
          {/if}
          {#if ankerLocal.gridDeviationW !== null}
            <span class="flex justify-between gap-2">
              <span>Écart</span>
              <span
                class="font-semibold"
                style="color: {deviationHigh ? 'var(--color-hp)' : 'var(--color-fg)'};"
              >
                {nf0.format(ankerLocal.gridDeviationW)} W{deviationHigh ? ' ⚠' : ''}
              </span>
            </span>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <p class="py-2 text-[12px]" style="color: var(--color-muted-fg);">
      {ankerLocal.status === 'idle'
        ? 'Lecture du compteur en cours…'
        : 'Compteur Anker injoignable en local — le EM-50 reste la mesure de référence.'}
    </p>
  {/if}
</section>
