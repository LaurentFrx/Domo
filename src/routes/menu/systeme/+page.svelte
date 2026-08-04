<script lang="ts">
  /**
   * Rubrique « Système » — anomalies actives, canal de notification, identité de
   * l'installation. C'est la cible des notifications Web Push : une alerte reçue
   * sur l'iPhone ouvre directement cette page.
   *
   * Le moniteur tente d'abord de RÉPARER ; ce qui reste listé ici demande une
   * attention humaine.
   */
  import { onMount } from 'svelte';
  import { health } from '$stores/health.svelte';
  import { clock } from '$stores/clock.svelte';
  import { pushStatus, enablePush, disablePush, type PushState } from '$lib/push-client';

  const APP_VERSION = '0.2.0';

  let pstate = $state<PushState>('disabled');
  let busy = $state(false);
  let testMsg = $state('');

  onMount(async () => {
    pstate = await pushStatus();
  });

  async function toggle() {
    busy = true;
    if (pstate === 'enabled') {
      pstate = await disablePush();
      testMsg = '';
    } else {
      pstate = await enablePush();
      // Confirme TOUT DE SUITE par une vraie notification : le canal est validé
      // dès l'activation, sans bouton « Tester » à chercher.
      if (pstate === 'enabled') {
        testMsg = 'Notification de test envoyée';
        await test();
      }
    }
    busy = false;
  }

  async function test() {
    testMsg = 'Envoi…';
    try {
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ test: true })
      });
      const d = (await r.json().catch(() => ({}))) as { sent?: number };
      testMsg = (d.sent ?? 0) > 0 ? 'Notification envoyée' : 'Aucun appareil abonné';
    } catch {
      testMsg = 'Échec de l’envoi';
    }
  }

  const pushLabel = $derived(
    pstate === 'enabled'
      ? 'Activées sur cet appareil'
      : pstate === 'denied'
        ? 'Bloquées — à réautoriser dans iOS'
        : pstate === 'unsupported'
          ? 'Ajouter l’app à l’écran d’accueil'
          : pstate === 'error'
            ? 'Erreur — réessayer'
            : 'Désactivées'
  );

  function ageMin(ts: number): number {
    return Math.max(1, Math.round((clock.now - ts) / 60_000));
  }
</script>

<section class="ios-section">
  <h2 class="ios-group-header">Anomalies</h2>
  <div class="ios-group">
    {#if health.incidents.length === 0}
      <div class="ios-cell">
        <span class="ios-cell-label">Aucune anomalie</span>
        <span class="ios-cell-value is-green">Tout répond</span>
      </div>
    {:else}
      {#each health.incidents as inc (inc.key)}
        <div class="ios-cell">
          <span class="ios-cell-text">
            <span class="ios-cell-label">{inc.message}</span>
            <span class="ios-cell-sub">
              depuis {ageMin(inc.firstTs)} min{#if inc.repaired}
                · réparation tentée : {inc.repaired}{/if}
            </span>
          </span>
          <span class="ios-cell-value" class:is-red={inc.severity === 'critical'}>
            {inc.severity === 'critical' ? 'Critique' : 'À surveiller'}
          </span>
        </div>
      {/each}
    {/if}
  </div>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Notifications</h2>
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-text">
        <span class="ios-cell-label">Alertes d'anomalie</span>
        <span class="ios-cell-sub">{pushLabel}{testMsg ? ` · ${testMsg}` : ''}</span>
      </span>
      <label class="ios-switch">
        <input
          type="checkbox"
          checked={pstate === 'enabled'}
          disabled={busy || pstate === 'unsupported' || pstate === 'denied'}
          aria-label="Alertes d'anomalie"
          onchange={toggle}
        />
        <span class="ios-switch-track"></span>
      </label>
    </div>
    {#if pstate === 'enabled'}
      <button type="button" class="ios-cell is-action" onclick={test}>
        Envoyer une notification de test
      </button>
    {/if}
  </div>
  <p class="ios-group-footer">
    Les alertes arrivent même app fermée, à condition que Domo soit installé sur l'écran d'accueil.
  </p>
</section>

<section class="ios-section">
  <h2 class="ios-group-header">Installation</h2>
  <div class="ios-group">
    <div class="ios-cell">
      <span class="ios-cell-label">Version</span>
      <span class="ios-cell-value">{APP_VERSION}</span>
    </div>
    <div class="ios-cell">
      <span class="ios-cell-label">Serveur</span>
      <span class="ios-cell-value">tazieff-dev</span>
    </div>
    <div class="ios-cell">
      <span class="ios-cell-label">Adresse</span>
      <span class="ios-cell-value">domo.feroux.fr</span>
    </div>
    <a class="ios-cell" href="https://code.feroux.fr" target="_blank" rel="noreferrer">
      <span class="ios-cell-label">Éditeur de code</span>
      <span class="ios-cell-value">code.feroux.fr</span>
      <svg
        class="ios-chevron"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M7 17L17 7 M9 7h8v8" />
      </svg>
    </a>
  </div>
</section>
