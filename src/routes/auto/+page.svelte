<script lang="ts">
  import { dashboard } from '$stores/dashboard.svelte';
  import { formatDate } from '$utils/format';
  import ModeSegmentedControl from '$components/tiles/ModeSegmentedControl.svelte';
  import AnimatedValue from '$components/ui/AnimatedValue.svelte';

  const date = $derived(formatDate());

  // ─── Scénarios (état local, mock — sera persisté plus tard) ────────────
  type Scenario = {
    id: string;
    title: string;
    description: string;
    active: boolean;
    locked?: boolean;
  };

  let scenarios = $state<Scenario[]>([
    {
      id: 'cumulus-pv',
      title: 'Cumulus PV',
      description: 'Chauffe sur surplus solaire > 1500 W',
      active: true
    },
    {
      id: 'heures-creuses',
      title: 'Heures creuses',
      description: 'Complément HC 22h-6h si T° < 45 °C',
      active: true
    },
    {
      id: 'anti-legio',
      title: 'Anti-légionellose',
      description: '60 °C tous les 7 jours',
      active: true,
      locked: true
    },
    {
      id: 'protection-surcharge',
      title: 'Protection surcharge',
      description: 'Bloque si charge > 2 kW (Daikin/induction)',
      active: true,
      locked: true
    }
  ]);

  function toggleScenario(id: string) {
    const s = scenarios.find((s) => s.id === id);
    if (!s || s.locked) return;
    s.active = !s.active;
  }

  // ─── Prochain événement cumulus (mock dérivé de l'heure) ───────────────
  let now = $state(new Date());
  $effect(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(t);
  });

  const nextEvent = $derived.by(() => {
    const h = now.getHours();
    if (h >= 22 || h < 6) return 'Force légionellose dans 3j';
    if (h >= 18) return 'HC à 22h00';
    return `HC à 22h00 (dans ${22 - h}h)`;
  });

  // ─── Historique mocké ──────────────────────────────────────────────────
  type Event = { time: string; label: string; kind: 'on' | 'off' | 'info' };
  const history: Event[] = [
    { time: '14:32', label: 'Cumulus ON (surplus PV 1.8 kW)', kind: 'on' },
    { time: '12:05', label: 'Cumulus OFF (nuages, prod 0.4 kW)', kind: 'off' },
    { time: '11:48', label: 'Cumulus ON (surplus PV 1.6 kW)', kind: 'on' },
    { time: '06:00', label: 'Fin de cycle HC (T° 47 °C)', kind: 'off' },
    { time: '02:14', label: 'Cumulus ON HC (T° 38 °C)', kind: 'on' }
  ];
</script>

<svelte:head>
  <title>Auto — Domo</title>
</svelte:head>

<div class="stagger-enter flex flex-col gap-2 md:gap-3">
  <header class="flex flex-col gap-1 pt-4 pb-2">
    <span class="text-xs font-medium tracking-wider text-[var(--text-secondary)]">{date}</span>
    <h1 class="text-2xl font-medium text-white">Automations</h1>
  </header>

  <div class="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
    <!-- Cumulus : statut + prochain event + mode control -->
    <section
      class="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 md:rounded-2xl md:p-4"
    >
      <div class="flex items-baseline justify-between">
        <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">
          CUMULUS
        </span>
        <span class="text-[10px] text-[var(--text-tertiary)]">{nextEvent}</span>
      </div>

      <div class="flex items-baseline justify-between">
        <div class="flex items-baseline gap-1">
          <AnimatedValue
            value={dashboard.cumulusTemp}
            decimals={1}
            class="text-3xl font-light text-white tabular-nums md:text-4xl"
          />
          <span class="text-base font-light text-[var(--text-secondary)]">°C</span>
        </div>
        <span class="text-[10px] font-semibold tracking-wider text-[var(--accent-500)]">
          MODE {dashboard.cumulusMode}
        </span>
      </div>

      <ModeSegmentedControl />
    </section>

    <!-- Historique récent -->
    <section
      class="flex flex-col gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 md:rounded-2xl md:p-4"
    >
      <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">
        HISTORIQUE — 5 DERNIERS ÉVÉNEMENTS
      </span>
      <ul class="flex flex-col divide-y divide-white/[0.05]">
        {#each history as e (e.time + e.label)}
          <li class="flex items-baseline gap-2 py-1.5">
            <span class="text-[10px] text-[var(--text-tertiary)] tabular-nums">{e.time}</span>
            <span
              class="text-xs"
              style:color={e.kind === 'on'
                ? 'var(--accent-500)'
                : e.kind === 'off'
                  ? 'var(--text-secondary)'
                  : 'var(--text-primary)'}
            >
              {e.label}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  </div>

  <!-- Scénarios -->
  <section class="flex flex-col gap-2">
    <span class="text-[10px] font-medium tracking-wider text-[var(--text-secondary)]">
      SCÉNARIOS
    </span>
    <div class="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3">
      {#each scenarios as s (s.id)}
        <div
          class="tile-press flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-3 md:rounded-2xl md:p-4"
        >
          <div class="flex flex-1 flex-col gap-0.5">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-white">{s.title}</span>
              {#if s.locked}
                <span class="text-[9px] tracking-wider text-[var(--text-tertiary)]">SYSTÈME</span>
              {/if}
            </div>
            <span class="text-[11px] leading-snug text-[var(--text-secondary)]">
              {s.description}
            </span>
          </div>

          <button
            type="button"
            class="scenario-toggle"
            class:on={s.active}
            class:locked={s.locked}
            disabled={s.locked}
            role="switch"
            aria-checked={s.active}
            aria-label="Activer {s.title}"
            onclick={() => toggleScenario(s.id)}
          >
            <span class="scenario-knob"></span>
          </button>
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  /* ─── Toggle pill (52×28 avec knob 28×28) ─── */
  .scenario-toggle {
    position: relative;
    flex-shrink: 0;
    width: 52px;
    height: 28px;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    padding: 0;
    transition:
      background-color var(--motion-base) var(--easing-default),
      border-color var(--motion-base) var(--easing-default);
    -webkit-tap-highlight-color: transparent;
  }

  .scenario-toggle.on {
    background: linear-gradient(135deg, var(--accent-600), var(--accent-500));
    border-color: rgba(141, 253, 195, 0.4);
    box-shadow:
      inset 0 2px 4px rgba(0, 0, 0, 0.2),
      0 0 12px rgba(61, 253, 152, 0.4);
  }

  .scenario-toggle.locked {
    opacity: 0.7;
    cursor: not-allowed;
  }

  .scenario-knob {
    position: absolute;
    top: 50%;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: linear-gradient(135deg, #ffffff, #e8e6f0);
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.5);
    transform: translateY(-50%);
    transition: left var(--motion-base) var(--easing-default);
  }

  .scenario-toggle.on .scenario-knob {
    left: calc(100% - 25px);
    box-shadow:
      0 3px 10px rgba(0, 0, 0, 0.5),
      0 0 12px rgba(61, 253, 152, 0.5);
  }
</style>
