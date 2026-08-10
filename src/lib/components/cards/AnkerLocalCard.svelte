<script lang="ts">
  import { ankerLocal } from '$stores/ankerLocal.svelte';

  // Tuile « batterie en local » : SOC + flux AC de la Solarbank Max AC lus en
  // Modbus TCP LAN (sans le cloud Solix ni sa latence ~60 s), + contrôle
  // croisé réseau Smart Meter Gen 2 ↔ EM-50 (le EM-50 reste la source de
  // vérité réseau ; une dérive durable = pince/CT à re-vérifier).
  const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });

  // + décharge vers la maison / − charge (convention du registre Anker).
  const acW = $derived(ankerLocal.acPowerW);
  const discharging = $derived(acW > 25);
  const charging = $derived(acW < -25);

  const flowLabel = $derived(
    discharging
      ? 'La batterie alimente la maison'
      : charging
        ? 'La batterie se recharge'
        : ankerLocal.batteryStatus === 'sleep'
          ? 'La batterie dort'
          : 'La batterie est en veille'
  );
  const flowColor = $derived(
    discharging ? 'var(--color-battery)' : charging ? 'var(--color-solar)' : 'var(--color-muted-fg)'
  );

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
  aria-label="Batterie Solarbank mesurée en local"
>
  <!-- En-tête : titre + mode actif + fraîcheur -->
  <div class="flex items-start justify-between gap-3">
    <div class="flex flex-col gap-0.5">
      <span class="text-[14px] font-semibold">Batterie · mesure locale</span>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        Solarbank Max AC · lecture directe (sans cloud)
      </span>
    </div>
    {#if ankerLocal.sbAvailable}
      <span
        class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.04em] whitespace-nowrap"
        style="background: var(--color-battery-muted); color: var(--color-battery);"
      >
        <span class="h-1 w-1 rounded-full" style="background: var(--color-battery);"></span>
        {ankerLocal.modeLabel}
      </span>
    {/if}
  </div>

  {#if ankerLocal.sbAvailable}
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-3">
      <!-- Bloc 1 : SOC + jauge -->
      <div class="flex flex-col gap-1.5">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Charge
        </span>
        <div class="flex items-baseline gap-1">
          <span
            class="text-[28px] leading-none font-semibold tabular-nums"
            style="color: var(--color-battery); letter-spacing: -0.01em;"
          >
            {ankerLocal.socPct}
          </span>
          <span class="text-[13px] font-medium" style="color: var(--color-muted-fg);">%</span>
        </div>
        <div class="soc-bar" role="img" aria-label="Batterie chargée à {ankerLocal.socPct} %">
          <div class="soc-fill" style="width: {ankerLocal.socPct}%;"></div>
        </div>
      </div>

      <!-- Bloc 2 : flux AC + état en mots -->
      <div class="flex flex-col gap-1.5">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Échange maison
        </span>
        <div class="flex items-baseline gap-1">
          <span
            class="text-[28px] leading-none font-semibold tabular-nums"
            style="color: {flowColor}; letter-spacing: -0.01em;"
          >
            {nf0.format(Math.abs(acW))}
          </span>
          <span class="text-[13px] font-medium" style="color: var(--color-muted-fg);">W</span>
        </div>
        <span class="text-[12px]" style="color: var(--color-muted-fg);">{flowLabel}</span>
      </div>

      <!-- Bloc 3 : contrôle croisé réseau (Gen 2 vs EM-50) -->
      <div class="flex flex-col gap-1.5">
        <span
          class="text-[11px] font-semibold tracking-[0.08em] uppercase"
          style="color: var(--color-muted-fg);"
        >
          Réseau · contrôle croisé
        </span>
        {#if ankerLocal.meterAvailable}
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
        {:else}
          <span class="text-[12px]" style="color: var(--color-muted-fg);">
            Compteur Anker injoignable
          </span>
        {/if}
      </div>
    </div>
  {:else}
    <p class="py-2 text-[12px]" style="color: var(--color-muted-fg);">
      {ankerLocal.status === 'idle'
        ? 'Lecture de la batterie en cours…'
        : 'Batterie injoignable en local — la mesure cloud de l’accueil reste disponible.'}
    </p>
  {/if}
</section>

<style>
  /* Jauge SOC : même famille que la prop-bar HP/HC (piste muted, remplissage
     sémantique batterie), transition douce entre deux polls. */
  .soc-bar {
    height: 10px;
    overflow: hidden;
    border-radius: 9999px;
    background: var(--color-muted);
  }
  .soc-fill {
    height: 100%;
    border-radius: 9999px;
    background: var(--color-battery);
    transition: width var(--duration-slow, 300ms) var(--ease-default, ease);
  }
</style>
