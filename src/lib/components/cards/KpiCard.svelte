<script lang="ts">
  import type { EnergyDomain } from '$theme/tokens';
  import Sparkline from '$components/ui/Sparkline.svelte';

  interface Props {
    label: string;
    value: string;
    unit?: string;
    /** Texte secondaire sous la valeur (ex: "+1.2 kWh/h"). */
    trend?: string;
    /** Badge pill optionnel (ex: mode "PV"). */
    badge?: string;
    domain: EnergyDomain;
    sparklineData?: number[];
    /** Couleur du badge si différente de domain. */
    badgeDomain?: EnergyDomain;
    /** href optionnel pour rendre la card cliquable. */
    href?: string;
  }

  let {
    label,
    value,
    unit,
    trend,
    badge,
    domain,
    sparklineData = [],
    badgeDomain,
    href
  }: Props = $props();

  const colorVar = $derived(`var(--color-${domain})`);
  const badgeColorVar = $derived(`var(--color-${badgeDomain ?? domain})`);
  const badgeMutedVar = $derived(`var(--color-${badgeDomain ?? domain}-muted)`);

  const Wrapper = $derived(href ? 'a' : 'div');
</script>

<svelte:element
  this={Wrapper}
  {href}
  class="kpi-card flex flex-col gap-2 rounded-[var(--radius-xl)] border p-4 transition-colors"
  style="background: var(--color-card); border-color: var(--color-border);"
>
  <!-- Label + badge -->
  <div class="flex items-center justify-between gap-2">
    <span
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      {label}
    </span>
    {#if badge}
      <span
        class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.04em]"
        style="background: {badgeMutedVar}; color: {badgeColorVar};"
      >
        <span class="h-1 w-1 rounded-full" style="background: {badgeColorVar};"></span>
        {badge}
      </span>
    {/if}
  </div>

  <!-- Value + unit -->
  <div class="flex items-baseline gap-1">
    <span
      class="text-[24px] font-semibold leading-none sm:text-[28px]"
      style="color: {colorVar}; letter-spacing: -0.01em;"
    >
      {value}
    </span>
    {#if unit}
      <span
        class="text-[13px] font-medium"
        style="color: var(--color-muted-fg);"
      >
        {unit}
      </span>
    {/if}
  </div>

  <!-- Trend -->
  {#if trend}
    <span class="text-[12px]" style="color: var(--color-muted-fg);">
      {trend}
    </span>
  {/if}

  <!-- Sparkline -->
  {#if sparklineData.length > 0}
    <div class="mt-1">
      <Sparkline data={sparklineData} color={colorVar} height={24} />
    </div>
  {/if}
</svelte:element>

<style>
  .kpi-card:hover {
    background: var(--color-card-hover);
  }
  a.kpi-card {
    text-decoration: none;
    cursor: pointer;
  }
</style>
