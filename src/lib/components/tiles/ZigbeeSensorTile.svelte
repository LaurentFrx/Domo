<script lang="ts">
  import type { ZigbeeDevice } from '$stores/zigbee.svelte';

  interface Props {
    device: ZigbeeDevice;
    /** Nom d'affichage override (sinon le friendlyName Zigbee du device). */
    name?: string;
    /** Compact : masque ZB / LQI en vue iPhone (réapparaissent dès sm). */
    compact?: boolean;
    /** Si fourni, la tuile devient cliquable (ex. ouvrir l'historique 4 h). */
    onActivate?: () => void;
  }

  let { device, name, compact = false, onActivate }: Props = $props();

  const displayName = $derived(name ?? device.friendlyName);

  // Number.isFinite (et non typeof === 'number') : un NaN/Infinity remonté par MQTT
  // passerait le test typeof et s'afficherait « NaN ». On le ramène à null.
  const temp = $derived<number | null>(
    Number.isFinite(device.state.temperature) ? (device.state.temperature as number) : null
  );
  const humidity = $derived<number | null>(
    Number.isFinite(device.state.humidity) ? (device.state.humidity as number) : null
  );
  const link = $derived<number | null>(
    Number.isFinite(device.state.linkquality) ? (device.state.linkquality as number) : null
  );
</script>

<!-- Tuile : <div> par défaut, vrai <button> si cliquable (focus/clavier natifs). -->
<svelte:element
  this={onActivate ? 'button' : 'div'}
  type={onActivate ? 'button' : undefined}
  class="tile-root flex flex-col gap-1.5 rounded-[var(--radius-xl)] border p-3"
  class:opacity-50={!device.available}
  class:tile-clickable={!!onActivate}
  style="background: var(--color-card); border-color: var(--color-border);"
  role={onActivate ? 'button' : undefined}
  aria-label={onActivate ? `Historique 4 h — ${displayName}` : undefined}
  onclick={onActivate}
>
  <div class="flex items-start justify-between gap-2">
    <span class="truncate text-[12px] leading-tight font-semibold" style="color: var(--color-fg);">
      {displayName}
    </span>
    <!-- Le badge « ZB » a été retiré : c'est le nom d'un protocole radio, il
         n'apprend rien à quelqu'un qui regarde la température de sa chambre. -->
  </div>

  <div class="flex items-baseline gap-3">
    {#if temp !== null}
      <div class="flex items-baseline gap-0.5">
        <span
          class="text-[22px] leading-none font-bold tabular-nums"
          style="color: var(--color-fg); letter-spacing: -0.01em;"
        >
          {temp.toFixed(1)}
        </span>
        <span class="text-[11px]" style="color: var(--color-muted-fg);">°C</span>
      </div>
    {/if}
    {#if humidity !== null}
      <div class="flex items-baseline gap-0.5">
        <span
          class="text-[15px] font-semibold tabular-nums"
          style="color: var(--color-consumption);"
        >
          {Math.round(humidity)}
        </span>
        <span class="text-[10px]" style="color: var(--color-muted-fg);">%</span>
      </div>
    {/if}
  </div>

  <!-- « LQI 118 » était une mesure de qualité radio brute, incompréhensible et
       affichée en permanence. On ne dit plus rien quand tout va bien, et une
       phrase en français quand le signal est réellement faible — c'est la seule
       information actionnable (rapprocher le capteur ou ajouter un répéteur). -->
  {#if link !== null && link < 50}
    <div
      class="flex items-center justify-end text-[10px] {compact ? 'hidden sm:flex' : ''}"
      style="color: var(--color-warning);"
      title="Qualité du lien radio : {link}/255"
    >
      <span>Signal faible</span>
    </div>
  {/if}
</svelte:element>

<style>
  /* Variante <button> : neutralise les styles natifs, conserve l'allure de tuile. */
  .tile-clickable {
    appearance: none;
    width: 100%;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
</style>
