<script lang="ts">
  /**
   * Carte conso d'un appareil électroménager (prise Zigbee). Pas de bouton on/off :
   * lecture seule, centrée sur « qui consomme et combien ». La puissance est rendue
   * par une PILULE de niveau (même forme arrondie que les interrupteurs/toggles de
   * l'app) qui se remplit proportionnellement à la puissance, sur une échelle commune
   * → on compare les appareils d'un coup d'œil. Carte « allumée » (couleur conso +
   * lueur) dès qu'un appareil consomme vraiment, sobre sinon.
   */
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';

  interface Props {
    device: ZigbeeDevice;
  }
  let { device }: Props = $props();

  const power = $derived(Number.isFinite(device.state.power) ? (device.state.power as number) : 0);
  const energy = $derived(
    Number.isFinite(device.state.energy) ? (device.state.energy as number) : null
  );

  // Remplissage en RACINE de la puissance (échelle ~0-2,5 kW) : une racine carrée
  // rend visibles les petites conso (frigo ~60 W → ~16 %) ET sature en douceur les
  // grosses (lave-linge ~2 kW → ~90 %). En linéaire, les conso courantes (<100 W)
  // paraîtraient vides sur une échelle au kW.
  const SCALE_W = 2500;
  const active = $derived(power > 10); // au-dessus de la veille (~quelques W)
  const fillPct = $derived(power <= 0 ? 0 : Math.min(100, Math.sqrt(power / SCALE_W) * 100));
</script>

<div
  class="appliance-card flex flex-col gap-2.5 rounded-[var(--radius-xl)] border p-3"
  class:is-active={active}
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Nom + énergie cumulée -->
  <div class="flex items-center justify-between gap-2">
    <span class="truncate text-[12px] leading-tight font-semibold" style="color: var(--color-fg);">
      {device.friendlyName}
    </span>
    {#if energy !== null}
      <span class="shrink-0 text-[10px] tabular-nums" style="color: var(--color-muted-fg);">
        {energy.toFixed(1)} kWh
      </span>
    {/if}
  </div>

  <!-- Puissance instantanée (le « combien ») -->
  <div class="flex items-baseline gap-1">
    <span class="appli-power text-[26px] leading-none font-bold tabular-nums">
      {power < 10 ? power.toFixed(1) : Math.round(power)}
    </span>
    <span class="text-[12px] font-medium" style="color: var(--color-muted-fg);">W</span>
  </div>

  <!-- Pilule de niveau (même visualisation que les interrupteurs, en jauge de conso) -->
  <div class="appli-bar">
    <div class="appli-fill" style="width: {fillPct}%;"></div>
  </div>
</div>

<style>
  .appli-power {
    color: var(--color-muted-fg);
    letter-spacing: -0.01em;
    transition: color 200ms ease;
  }
  .appliance-card.is-active .appli-power {
    color: var(--color-consumption);
  }

  /* La pilule : forme arrondie des toggles, en rail de niveau. */
  .appli-bar {
    height: 0.75rem;
    border-radius: 9999px;
    overflow: hidden;
    background: var(--color-muted);
    box-shadow: inset 0 1px 2px oklch(0 0 0 / 0.18);
  }
  .appli-fill {
    height: 100%;
    border-radius: 9999px;
    /* repos : fin liseré neutre (presque vide) */
    background: var(--color-border-strong);
    transition:
      width 600ms var(--ease-out),
      background 200ms ease;
  }
  /* Consomme : remplissage couleur conso + lueur (oklch littéral / var → Chrome-safe). */
  .appliance-card.is-active .appli-fill {
    background: var(--color-consumption);
    box-shadow: 0 0 8px var(--color-consumption);
  }
  .appliance-card.is-active {
    border-color: var(--color-consumption);
  }
</style>
