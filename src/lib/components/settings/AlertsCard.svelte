<script lang="ts">
  // Carte « Alertes & anomalies » (Réglages) : active les notifications Web Push
  // (canal immédiat même app fermée) et liste les anomalies actives détectées par
  // le moniteur. Le moniteur tente d'abord de réparer ; ce qui reste ici demande
  // une attention humaine.
  import { onMount } from 'svelte';
  import { health } from '$stores/health.svelte';
  import { pushStatus, enablePush, disablePush, type PushState } from '$lib/push-client';

  let pstate = $state<PushState>('disabled');
  let busy = $state(false);
  let testMsg = $state('');

  onMount(async () => {
    pstate = await pushStatus();
  });

  async function toggle() {
    busy = true;
    pstate = pstate === 'enabled' ? await disablePush() : await enablePush();
    busy = false;
  }

  async function test() {
    testMsg = '…';
    try {
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ test: true })
      });
      const d = (await r.json().catch(() => ({}))) as { sent?: number };
      testMsg = (d.sent ?? 0) > 0 ? 'Notification envoyée ✓' : 'Aucun appareil abonné';
    } catch {
      testMsg = 'Échec de l’envoi';
    }
  }

  const pushLabel = $derived(
    pstate === 'enabled'
      ? 'Alertes activées sur cet appareil'
      : pstate === 'denied'
        ? 'Notifications bloquées (à réautoriser dans iOS)'
        : pstate === 'unsupported'
          ? 'Indisponible — installer l’app sur l’écran d’accueil'
          : pstate === 'error'
            ? 'Erreur — réessayer'
            : 'Alertes désactivées sur cet appareil'
  );

  function ageMin(ts: number): number {
    return Math.max(1, Math.round((Date.now() - ts) / 60_000));
  }
  function dotColor(sev: string): string {
    return sev === 'critical' ? 'var(--color-alert)' : 'oklch(0.66 0.14 75)';
  }
</script>

<section class="flex flex-col gap-3">
  <h2
    class="text-[11px] font-semibold tracking-[0.08em] uppercase"
    style="color: var(--color-muted-fg);"
  >
    Alertes &amp; anomalies
  </h2>

  <div
    class="flex flex-col divide-y rounded-[var(--radius-xl)] border"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <!-- Activation des notifications -->
    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-[13px] font-semibold">Notifications d’anomalie</span>
        <span class="truncate text-[11px]" style="color: var(--color-muted-fg);">{pushLabel}</span>
        {#if testMsg}<span class="text-[11px]" style="color: var(--color-muted-fg);">{testMsg}</span
          >{/if}
      </div>
      <div class="flex shrink-0 items-center gap-2">
        {#if pstate === 'enabled'}
          <button
            class="rounded-full border px-3 py-1 text-[12px] font-medium"
            style="border-color: var(--color-border); color: var(--color-muted-fg);"
            onclick={test}>Tester</button
          >
        {/if}
        <button
          class="rounded-full px-3 py-1 text-[12px] font-semibold disabled:opacity-50"
          style="background: {pstate === 'enabled'
            ? 'transparent'
            : 'var(--color-primary)'}; color: {pstate === 'enabled'
            ? 'var(--color-muted-fg)'
            : 'var(--color-primary-fg, white)'}; border: 1px solid {pstate === 'enabled'
            ? 'var(--color-border)'
            : 'transparent'};"
          disabled={busy || pstate === 'unsupported' || pstate === 'denied'}
          onclick={toggle}
        >
          {pstate === 'enabled' ? 'Désactiver' : 'Activer'}
        </button>
      </div>
    </div>

    <!-- Liste des anomalies actives -->
    {#if health.incidents.length === 0}
      <div class="flex items-center gap-2.5 px-4 py-3">
        <span class="h-2 w-2 shrink-0 rounded-full" style="background: var(--color-ok, #34d399);"
        ></span>
        <span class="text-[13px]" style="color: var(--color-muted-fg);">
          Aucune anomalie — toutes les sources répondent.
        </span>
      </div>
    {:else}
      {#each health.incidents as inc (inc.key)}
        <div class="flex items-start gap-2.5 px-4 py-3">
          <span
            class="mt-1 h-2 w-2 shrink-0 rounded-full"
            style="background: {dotColor(inc.severity)};"
          ></span>
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="text-[13px] font-semibold" style="color: var(--color-fg);"
              >{inc.message}</span
            >
            <span class="text-[11px]" style="color: var(--color-muted-fg);">
              Depuis {ageMin(inc.firstTs)} min{#if inc.repaired}
                · ↻ {inc.repaired}{/if}
            </span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</section>
