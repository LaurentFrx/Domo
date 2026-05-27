<script lang="ts">
  import { onMount } from 'svelte';
  import { enhance } from '$app/forms';
  import { matter } from '$stores/matter.svelte';
  import { preferences } from '$stores/preferences.svelte';

  const APP_VERSION = '0.1.0';

  const matterStatusLabel = $derived(
    matter.connectionStatus === 'connected'
      ? 'Connecté'
      : matter.connectionStatus === 'connecting'
        ? 'Connexion…'
        : 'Déconnecté'
  );
  const matterStatusColor = $derived(
    matter.connectionStatus === 'connected'
      ? 'var(--accent-500)'
      : matter.connectionStatus === 'connecting'
        ? 'var(--warning)'
        : 'var(--error)'
  );
  const matterDeviceCount = $derived(matter.shutters.length + matter.switches.length);

  onMount(() => {
    preferences.hydrate();
    if (matter.connectionStatus === 'disconnected') {
      matter.connect();
    }
  });
</script>

<svelte:head>
  <title>Réglages — Domo</title>
</svelte:head>

<div class="stagger-enter flex flex-col gap-3 md:gap-4">
  <header class="flex flex-col gap-1 pt-4 pb-2">
    <h1 class="text-2xl font-medium text-white">Réglages</h1>
  </header>

  <div class="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
    <!-- ─── Système ─────────────────────────────────────────────── -->
    <section class="flex flex-col gap-2">
      <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
        >SYSTÈME</span
      >
      <div
        class="flex flex-col divide-y divide-white/[0.06] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)] md:rounded-2xl"
      >
        <div class="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3">
          <span class="text-sm text-white">Matter</span>
          <span class="flex items-center gap-1.5 text-xs" style:color={matterStatusColor}>
            <span class="h-1.5 w-1.5 rounded-full" style:background-color={matterStatusColor}
            ></span>
            {matterStatusLabel}
            {#if matter.connectionStatus === 'connected'}
              <span class="text-[10px] text-[var(--text-tertiary)]"
                >· {matterDeviceCount} appareil{matterDeviceCount > 1 ? 's' : ''}</span
              >
            {/if}
          </span>
        </div>
        <div class="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3">
          <span class="text-sm text-white">Version</span>
          <span class="text-xs text-[var(--text-secondary)] tabular-nums">{APP_VERSION}</span>
        </div>
        <div class="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3">
          <span class="text-sm text-white">VPS</span>
          <span class="flex items-center gap-1.5 text-xs text-[var(--accent-500)]">
            <span class="h-1.5 w-1.5 rounded-full bg-[var(--accent-500)]"></span>
            En ligne
          </span>
        </div>
      </div>
    </section>

    <!-- ─── Cumulus ─────────────────────────────────────────────── -->
    <section class="flex flex-col gap-2">
      <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
        >CUMULUS</span
      >
      <div
        class="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 shadow-[var(--shadow-card)] md:rounded-2xl md:p-4"
      >
        <!-- Seuil PV -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <label for="pv-threshold" class="text-sm text-white">Seuil surplus PV</label>
            <span class="text-xs text-[var(--accent-500)] tabular-nums">
              {preferences.pvThreshold} W
            </span>
          </div>
          <input
            id="pv-threshold"
            class="yeldra-range"
            type="range"
            min="500"
            max="3000"
            step="100"
            value={preferences.pvThreshold}
            oninput={(e) =>
              preferences.setPvThreshold(+(e.currentTarget as HTMLInputElement).value)}
          />
          <div class="flex justify-between text-[9px] text-[var(--text-tertiary)]">
            <span>500 W</span>
            <span>3000 W</span>
          </div>
        </div>

        <div class="h-px w-full bg-white/[0.06]"></div>

        <!-- T° min HC -->
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between">
            <label for="hc-min-temp" class="text-sm text-white">Température mini HC</label>
            <span class="text-xs text-[var(--primary-400)] tabular-nums">
              {preferences.hcMinTemp} °C
            </span>
          </div>
          <input
            id="hc-min-temp"
            class="yeldra-range"
            type="range"
            min="35"
            max="55"
            step="1"
            value={preferences.hcMinTemp}
            oninput={(e) => preferences.setHcMinTemp(+(e.currentTarget as HTMLInputElement).value)}
          />
          <div class="flex justify-between text-[9px] text-[var(--text-tertiary)]">
            <span>35 °C</span>
            <span>55 °C</span>
          </div>
        </div>

        <div class="h-px w-full bg-white/[0.06]"></div>

        <!-- Anti-légio : info statique -->
        <div class="flex items-center justify-between">
          <div class="flex flex-col">
            <span class="text-sm text-white">Anti-légionellose</span>
            <span class="text-[10px] text-[var(--text-tertiary)]">Cycle non modifiable</span>
          </div>
          <span class="text-xs text-[var(--warning)]">60 °C / 7 jours</span>
        </div>
      </div>
    </section>

    <!-- ─── Affichage ───────────────────────────────────────────── -->
    <section class="flex flex-col gap-2">
      <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]"
        >AFFICHAGE</span
      >
      <div
        class="flex flex-col divide-y divide-white/[0.06] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)] md:rounded-2xl"
      >
        <!-- Unités -->
        <div class="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3">
          <span class="text-sm text-white">Unité de puissance</span>
          <div
            class="inline-flex overflow-hidden rounded-full border border-[var(--border-subtle)] text-[10px] font-medium"
          >
            <button
              type="button"
              class="unit-btn"
              class:unit-active={preferences.powerUnit === 'kW'}
              onclick={() => preferences.setPowerUnit('kW')}
            >
              kW
            </button>
            <button
              type="button"
              class="unit-btn"
              class:unit-active={preferences.powerUnit === 'W'}
              onclick={() => preferences.setPowerUnit('W')}
            >
              W
            </button>
          </div>
        </div>

        <!-- Animations -->
        <div class="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3">
          <div class="flex flex-col">
            <span class="text-sm text-white">Animations</span>
            <span class="text-[10px] text-[var(--text-tertiary)]"
              >Démo ticker actif sur les valeurs</span
            >
          </div>
          <button
            type="button"
            class="settings-toggle"
            class:on={preferences.animationsEnabled}
            role="switch"
            aria-checked={preferences.animationsEnabled}
            aria-label="Basculer les animations"
            onclick={() => preferences.setAnimationsEnabled(!preferences.animationsEnabled)}
          >
            <span class="settings-knob"></span>
          </button>
        </div>
      </div>
    </section>

    <!-- ─── Compte ──────────────────────────────────────────────── -->
    <section class="flex flex-col gap-2">
      <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">COMPTE</span
      >
      <div
        class="flex flex-col divide-y divide-white/[0.06] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] shadow-[var(--shadow-card)] md:rounded-2xl"
      >
        <a
          href="https://github.com/LaurentFrx/Domo"
          target="_blank"
          rel="noopener"
          class="flex items-center justify-between px-3 py-2.5 transition-colors hover:bg-[var(--surface-card-hover)] md:px-4 md:py-3"
        >
          <div class="flex flex-col">
            <span class="text-sm text-white">À propos</span>
            <span class="text-[10px] text-[var(--text-tertiary)]">
              Domo {APP_VERSION} · Laurent Feroux
            </span>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-[var(--text-secondary)]"
          >
            <path d="M7 17 L17 7 M9 7 H17 V15" />
          </svg>
        </a>

        <div class="flex items-center justify-between px-3 py-2.5 md:px-4 md:py-3">
          <div class="flex flex-col">
            <span class="text-sm text-white">Session</span>
            <span class="text-[10px] text-[var(--text-tertiary)]"
              >Fermer la session sur cet appareil</span
            >
          </div>
          <form method="POST" action="/api/auth/logout" use:enhance>
            <button
              type="submit"
              class="rounded-full border border-[var(--error)] px-3 py-1.5 text-[11px] font-medium text-[var(--error)] transition-colors hover:bg-[var(--error)] hover:text-white"
            >
              Déconnexion
            </button>
          </form>
        </div>
      </div>
    </section>
  </div>
</div>

<style>
  /* ─── Range slider Yeldra ─── */
  .yeldra-range {
    width: 100%;
    height: 4px;
    appearance: none;
    background: var(--border-default);
    border-radius: 9999px;
    outline: none;
    cursor: pointer;
  }
  .yeldra-range::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, #fff, #e8e6f0);
    box-shadow:
      0 2px 6px rgba(0, 0, 0, 0.5),
      0 0 12px rgba(61, 253, 152, 0.4);
    cursor: pointer;
    transition: transform var(--motion-fast) var(--easing-default);
  }
  .yeldra-range::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, #fff, #e8e6f0);
    box-shadow:
      0 2px 6px rgba(0, 0, 0, 0.5),
      0 0 12px rgba(61, 253, 152, 0.4);
    cursor: pointer;
    border: none;
  }
  .yeldra-range:active::-webkit-slider-thumb {
    transform: scale(1.1);
  }

  /* ─── Unit segmented ─── */
  .unit-btn {
    padding: 0.25rem 0.625rem;
    color: var(--text-secondary);
    background-color: transparent;
    cursor: pointer;
    transition:
      background-color var(--motion-fast),
      color var(--motion-fast);
  }
  .unit-active {
    background-color: var(--accent-500);
    color: var(--surface-base);
  }

  /* ─── Settings toggle (knob 28, track 52×28) ─── */
  .settings-toggle {
    position: relative;
    width: 52px;
    height: 28px;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    padding: 0;
    transition: background-color var(--motion-base) var(--easing-default);
    -webkit-tap-highlight-color: transparent;
  }
  .settings-toggle.on {
    background: linear-gradient(135deg, var(--accent-600), var(--accent-500));
    border-color: rgba(141, 253, 195, 0.4);
    box-shadow:
      inset 0 2px 4px rgba(0, 0, 0, 0.2),
      0 0 12px rgba(61, 253, 152, 0.4);
  }
  .settings-knob {
    position: absolute;
    top: 50%;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: linear-gradient(135deg, #fff, #e8e6f0);
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5);
    transform: translateY(-50%);
    transition: left var(--motion-base) var(--easing-default);
  }
  .settings-toggle.on .settings-knob {
    left: calc(100% - 25px);
  }
</style>
