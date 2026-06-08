<script lang="ts">
  /**
   * Page « Planning d'Isabelle » — saisie de l'occupation hebdomadaire qui
   * pilotera les créneaux de confort du thermostat sèche-serviette.
   *
   * Pensée iPad : une vue semaine (7 mini-timelines en aperçu, cliquables) +
   * un éditeur large du jour sélectionné + une zone d'exceptions ponctuelles.
   * Sur iPhone, tout s'empile proprement (colonne unique).
   */
  import { onMount } from 'svelte';
  import { planning, DAY_LABELS, DAY_SHORT } from '$stores/planning.svelte';

  let selectedDay = $state(0);

  onMount(() => {
    planning.hydrate();
  });

  function toMin(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  /** Position d'un créneau sur une timeline verticale 0–24h (top/height en %). */
  function slotStyle(slot: { start: string; end: string }): string {
    const a = Math.max(0, Math.min(1440, toMin(slot.start)));
    const b = Math.max(a, Math.min(1440, toMin(slot.end)));
    const top = (a / 1440) * 100;
    const h = Math.max(1.5, ((b - a) / 1440) * 100);
    return `top: ${top}%; height: ${h}%;`;
  }

  function fmtExceptionDate(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  let newExceptionDate = $state('');
  function addException() {
    if (!newExceptionDate) return;
    planning.addException(newExceptionDate);
    newExceptionDate = '';
  }
</script>

<svelte:head>
  <title>Planning d'Isabelle — Domo</title>
</svelte:head>

<div class="flex flex-col gap-6 py-4">
  <!-- En-tête -->
  <div class="flex flex-col gap-1">
    <a
      href="/reglages"
      class="text-[12px] font-medium"
      style="color: var(--color-primary);"
      data-sveltekit-preload-data
    >
      ← Réglages
    </a>
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Planning d'Isabelle</h1>
      <span class="text-[11px]" style="color: var(--color-muted-fg);">
        {#if planning.saving}Enregistrement…{:else if planning.lastError}⚠ {planning.lastError}{:else}Enregistré{/if}
      </span>
    </div>
    <p class="text-[12px]" style="color: var(--color-muted-fg);">
      Les plages d'occupation (travail, présence) déterminent les créneaux de chauffe confort de la
      salle de bain. Le daemon les combine au calendrier scolaire et aux jours fériés.
    </p>
  </div>

  <!-- ═══ Aperçu semaine (7 timelines cliquables) ═══ -->
  <section class="flex flex-col gap-2">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Semaine type
    </h2>
    <div class="grid grid-cols-7 gap-1.5 sm:gap-2">
      {#each DAY_LABELS as label, day (day)}
        <button
          type="button"
          class="tl-day"
          class:tl-active={selectedDay === day}
          aria-label="Modifier {label}"
          onclick={() => (selectedDay = day)}
        >
          <span class="tl-day-label">{DAY_SHORT[day]}</span>
          <div class="tl-track">
            <span class="tl-grad" style="top: 25%;"></span>
            <span class="tl-grad" style="top: 50%;"></span>
            <span class="tl-grad" style="top: 75%;"></span>
            {#each planning.week[day] as slot, i (i)}
              <span class="tl-slot" style={slotStyle(slot)}></span>
            {/each}
          </div>
          <span class="tl-count">{planning.week[day].length || '·'}</span>
        </button>
      {/each}
    </div>
  </section>

  <!-- ═══ Éditeur du jour sélectionné ═══ -->
  <section class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <h2
        class="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style="color: var(--color-muted-fg);"
      >
        {DAY_LABELS[selectedDay]}
      </h2>
      {#if selectedDay < 5}
        <button
          type="button"
          class="pl-ghost"
          onclick={() => planning.copyDayToWeekdays(selectedDay)}
        >
          Appliquer à lun–ven
        </button>
      {/if}
    </div>

    <div
      class="flex flex-col gap-3 rounded-[var(--radius-xl)] border p-4"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      {#each planning.week[selectedDay] as slot, i (i)}
        <div class="flex items-center gap-2">
          <input
            type="time"
            bind:value={planning.week[selectedDay][i].start}
            onchange={() => planning.save()}
            class="pl-time"
          />
          <span style="color: var(--color-muted-fg);">–</span>
          <input
            type="time"
            bind:value={planning.week[selectedDay][i].end}
            onchange={() => planning.save()}
            class="pl-time"
          />
          <button
            type="button"
            class="pl-del ml-auto"
            aria-label="Supprimer ce créneau"
            onclick={() => planning.removeSlot(selectedDay, i)}
          >
            ×
          </button>
        </div>
      {/each}
      {#if planning.week[selectedDay].length === 0}
        <p class="text-[13px]" style="color: var(--color-muted-fg);">
          Aucun créneau — journée sans occupation programmée (chauffe éco / hors-gel).
        </p>
      {/if}
      <button type="button" class="pl-add" onclick={() => planning.addSlot(selectedDay)}>
        + Ajouter un créneau
      </button>
    </div>
  </section>

  <!-- ═══ Exceptions ponctuelles ═══ -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Exceptions ponctuelles
    </h2>
    <p class="text-[12px]" style="color: var(--color-muted-fg);">
      Une date précise surcharge la semaine type (semaine atypique, congé…).
    </p>

    <div class="flex items-center gap-2">
      <input type="date" bind:value={newExceptionDate} class="pl-time" />
      <button type="button" class="pl-add" onclick={addException}>Ajouter une date</button>
    </div>

    {#each planning.exceptions as exc, ei (exc.date)}
      <div
        class="flex flex-col gap-3 rounded-[var(--radius-xl)] border p-4"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-[14px] font-semibold capitalize" style="color: var(--color-fg);">
            {fmtExceptionDate(exc.date)}
          </span>
          <button type="button" class="pl-ghost" onclick={() => planning.removeException(exc.date)}>
            Supprimer
          </button>
        </div>
        {#each exc.slots as slot, i (i)}
          <div class="flex items-center gap-2">
            <input
              type="time"
              bind:value={planning.exceptions[ei].slots[i].start}
              onchange={() => planning.save()}
              class="pl-time"
            />
            <span style="color: var(--color-muted-fg);">–</span>
            <input
              type="time"
              bind:value={planning.exceptions[ei].slots[i].end}
              onchange={() => planning.save()}
              class="pl-time"
            />
            <button
              type="button"
              class="pl-del ml-auto"
              aria-label="Supprimer ce créneau"
              onclick={() => planning.removeExceptionSlot(exc.date, i)}
            >
              ×
            </button>
          </div>
        {/each}
        {#if exc.slots.length === 0}
          <p class="text-[13px]" style="color: var(--color-muted-fg);">
            Aucun créneau — journée entièrement éco/hors-gel.
          </p>
        {/if}
        <button type="button" class="pl-add" onclick={() => planning.addExceptionSlot(exc.date)}>
          + Ajouter un créneau
        </button>
      </div>
    {/each}
  </section>
</div>

<style>
  /* ─── Aperçu : timeline d'un jour ─── */
  .tl-day {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.25rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-card);
    cursor: pointer;
    transition:
      border-color 180ms ease,
      background 180ms ease;
  }
  .tl-day.tl-active {
    border-color: var(--color-primary);
    background: color-mix(in oklch, var(--color-primary) 12%, transparent);
  }
  .tl-day-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .tl-track {
    position: relative;
    width: 100%;
    height: 130px;
    border-radius: 6px;
    background: var(--color-muted);
    overflow: hidden;
  }
  .tl-grad {
    position: absolute;
    left: 0;
    right: 0;
    height: 1px;
    background: var(--color-border);
  }
  .tl-slot {
    position: absolute;
    left: 2px;
    right: 2px;
    border-radius: 3px;
    background: color-mix(in oklch, var(--color-hp) 55%, transparent);
    border: 1px solid var(--color-hp);
  }
  .tl-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-muted-fg);
    font-variant-numeric: tabular-nums;
  }

  /* ─── Inputs & boutons d'édition ─── */
  .pl-time {
    font-size: 16px; /* anti-zoom iOS */
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 0.4rem 0.6rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .pl-time:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .pl-del {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.85rem;
    height: 1.85rem;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-alert);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .pl-add {
    align-self: flex-start;
    padding: 0.45rem 0.9rem;
    border-radius: var(--radius-pill);
    border: 1px dashed var(--color-border-strong);
    background: transparent;
    color: var(--color-primary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .pl-ghost {
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-muted-fg);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }

  @media (prefers-reduced-motion: reduce) {
    .tl-day {
      transition: none;
    }
  }
</style>
