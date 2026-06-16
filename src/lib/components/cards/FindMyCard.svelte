<script lang="ts">
  import { onMount } from 'svelte';
  import { findmy, type FindMyDevice } from '$stores/findmy.svelte';

  // Horloge locale (rafraîchie toutes les 30 s) pour que les « il y a X min »
  // restent vivants entre deux publications MQTT (cadence bridge = 120 s).
  let now = $state(Date.now());
  onMount(() => {
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  const devices = $derived(findmy.sorted);
  // Carte masquée tant que MQTT n'est pas câblé et qu'on n'a rien en cache.
  const visible = $derived(
    findmy.connectionStatus !== 'unconfigured' &&
      (devices.length > 0 ||
        findmy.connectionStatus === 'connecting' ||
        findmy.connectionStatus === 'connected')
  );

  // ─── État de santé global (chip d'en-tête) ───
  type Health = { label: string; color: string };
  const health = $derived.by<Health>(() => {
    if (findmy.connectionStatus === 'connecting') return { label: 'Connexion…', color: 'muted-fg' };
    if (findmy.connectionStatus === 'disconnected')
      return { label: 'Hors ligne', color: 'warning' };
    switch (findmy.status) {
      case 'ok':
        return { label: 'À jour', color: 'battery' };
      case 'starting':
        return { label: 'Démarrage…', color: 'warning' };
      case 'reauth_required':
        return { label: 'Ré-auth iCloud requise', color: 'alert' };
      case 'offline':
        return { label: 'Bridge hors ligne', color: 'muted-fg' };
      default:
        return { label: '', color: 'muted-fg' };
    }
  });

  function ago(epochS: number | null, nowMs: number): string {
    if (epochS == null) return '';
    const diff = Math.max(0, nowMs / 1000 - epochS);
    if (diff < 45) return "à l'instant";
    if (diff < 5400) return `il y a ${Math.round(diff / 60)} min`;
    if (diff < 86400) return `il y a ${Math.round(diff / 3600)} h`;
    return `il y a ${Math.round(diff / 86400)} j`;
  }

  // Batterie fiable seulement si statut ≠ Unknown (AirPods / appareils hors ligne
  // remontent souvent « 0 % / Unknown » → on affiche « — » plutôt qu'un faux 0 %).
  function batteryPct(d: FindMyDevice): number | null {
    if (d.battery == null || d.batteryStatus === 'Unknown') return null;
    return Math.round(d.battery);
  }
  function batteryColor(d: FindMyDevice): string {
    const p = batteryPct(d);
    if (p == null) return 'var(--color-muted-fg)';
    if (d.charging) return 'var(--color-battery)';
    if (p > 50) return 'var(--color-battery)';
    if (p > 20) return 'var(--color-warning)';
    return 'var(--color-alert)';
  }

  function mapsUrl(d: FindMyDevice): string {
    return `https://maps.apple.com/?ll=${d.lat},${d.lon}&q=${encodeURIComponent(d.name)}`;
  }

  // Icône SVG par type d'appareil (trait = currentColor, hérite de la pastille).
  function iconSvg(cls: string | null): string {
    const s = (cls || '').toLowerCase();
    const open =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">';
    let inner: string;
    if (s.includes('iphone'))
      inner =
        '<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><line x1="10.5" y1="5" x2="13.5" y2="5"/>';
    else if (s.includes('ipad'))
      inner =
        '<rect x="4.5" y="3" width="15" height="18" rx="2.2"/><circle cx="12" cy="18" r="0.5"/>';
    else if (s.includes('watch'))
      inner =
        '<rect x="7" y="6.5" width="10" height="11" rx="3"/><path d="M9 6.5l.6-3.2h4.8l.6 3.2"/><path d="M9 17.5l.6 3.2h4.8l.6-3.2"/>';
    else if (s.includes('mac'))
      inner = '<rect x="3.5" y="5" width="17" height="11" rx="1.6"/><path d="M2 19.5h20"/>';
    else if (s.includes('accessory') || s.includes('airpod'))
      inner =
        '<path d="M5 13v-1.5a7 7 0 0 1 14 0V13"/><rect x="3.2" y="12.5" width="4" height="6.5" rx="1.6"/><rect x="16.8" y="12.5" width="4" height="6.5" rx="1.6"/>';
    else
      inner =
        '<path d="M12 21s-5.5-4.8-5.5-9.2A5.5 5.5 0 0 1 12 6.3a5.5 5.5 0 0 1 5.5 5.5C17.5 16.2 12 21 12 21z"/><circle cx="12" cy="11.6" r="1.9"/>';
    return open + inner + '</svg>';
  }
</script>

{#if visible}
  <section
    class="rounded-[var(--radius-2xl)] border p-4 sm:p-5"
    style="background: var(--color-card); border-color: var(--color-border);"
    aria-label="Appareils Localiser"
  >
    <!-- ─── En-tête ─── -->
    <header class="mb-3 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="fm-title-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="16"
            height="16"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </span>
        <h2 class="text-base font-semibold tracking-tight" style="color: var(--color-fg);">
          Localiser
        </h2>
        {#if findmy.count > 0}
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums"
            style="background: var(--color-primary-muted); color: var(--color-primary);"
          >
            {findmy.count}
          </span>
        {/if}
      </div>

      {#if health.label}
        <span
          class="flex shrink-0 items-center gap-1.5 text-[11px] font-medium"
          style="color: var(--color-{health.color});"
        >
          <span class="h-1.5 w-1.5 rounded-full" style="background: var(--color-{health.color});"
          ></span>
          {health.label}
        </span>
      {/if}
    </header>

    <!-- ─── Liste des appareils ─── -->
    {#if devices.length > 0}
      <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {#each devices as d (d.topicId)}
          {@const pct = batteryPct(d)}
          {@const color = batteryColor(d)}
          <article class="fm-row flex items-center gap-3 rounded-[var(--radius-xl)] p-2.5">
            <!-- Pastille icône -->
            <span class="fm-chip" aria-hidden="true">{@html iconSvg(d.deviceClass)}</span>

            <!-- Nom + localisation -->
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                class="truncate text-[13px] leading-tight font-semibold"
                style="color: var(--color-fg);"
              >
                {d.name}
              </span>
              <span class="flex flex-wrap items-center gap-x-1.5 text-[11px] leading-tight">
                {#if d.lat != null && d.lon != null}
                  <span style="color: var(--color-muted-fg);">
                    Localisé{#if d.accuracy != null}&nbsp;· ±{Math.round(d.accuracy)} m{/if}
                    {#if d.fixTs}&nbsp;· {ago(d.fixTs, now)}{/if}
                  </span>
                  <a
                    class="fm-link"
                    href={mapsUrl(d)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Voir {d.name} sur le plan"
                  >
                    Plan&nbsp;↗
                  </a>
                {:else}
                  <span style="color: var(--color-muted-fg);">Position inconnue</span>
                {/if}
              </span>
            </div>

            <!-- Batterie -->
            <div class="flex shrink-0 flex-col items-end gap-1">
              <div class="flex items-center gap-1">
                {#if d.charging}
                  <svg
                    viewBox="0 0 24 24"
                    width="11"
                    height="11"
                    fill="var(--color-battery)"
                    aria-hidden="true"
                  >
                    <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
                  </svg>
                {/if}
                <span class="text-[13px] font-bold tabular-nums" style="color: {color};">
                  {pct == null ? '—' : `${pct} %`}
                </span>
              </div>
              <div class="fm-batt-track" aria-hidden="true">
                <div
                  class="fm-batt-fill"
                  style="width: {pct == null ? 0 : pct}%; background: {color};"
                ></div>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {:else}
      <p class="py-2 text-[12px]" style="color: var(--color-muted-fg);">
        {findmy.connectionStatus === 'connecting'
          ? 'Connexion au service Localiser…'
          : 'Aucun appareil pour le moment.'}
      </p>
    {/if}
  </section>
{/if}

<style>
  .fm-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--color-primary);
  }

  /* Rangée appareil : pas de fond « verre » (évite le double backdrop-filter) —
     juste un liseré discret + survol, l'icône colorée porte le repère visuel. */
  .fm-row {
    border: 1px solid var(--color-border);
    background: transparent;
    transition:
      border-color var(--duration-normal, 200ms),
      background var(--duration-normal, 200ms);
  }
  .fm-row:hover {
    border-color: var(--color-border-strong);
  }

  .fm-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    border-radius: var(--radius-lg);
    background: var(--color-primary-muted);
    color: var(--color-primary);
  }

  .fm-link {
    font-weight: 600;
    color: var(--color-primary);
    white-space: nowrap;
    transition: opacity var(--duration-fast, 100ms);
    -webkit-tap-highlight-color: transparent;
  }
  .fm-link:hover {
    opacity: 0.75;
  }

  /* Jauge batterie : piste arrondie + remplissage coloré (pas de box-shadow
     color-mix → conforme au piège Chrome documenté). */
  .fm-batt-track {
    width: 38px;
    height: 5px;
    border-radius: 9999px;
    background: var(--color-border);
    overflow: hidden;
  }
  .fm-batt-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width var(--duration-slow, 300ms) var(--ease-default, ease);
  }
</style>
