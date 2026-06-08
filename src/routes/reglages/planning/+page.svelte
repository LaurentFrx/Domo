<script lang="ts">
  /**
   * « Mes matins » — saisie du planning d'Isabelle, pensée pour une utilisatrice
   * non technicienne. On ne saisit QUE l'heure du premier cours par jour ; la
   * chauffe de la salle de bain est dérivée côté daemon (réveil = 1er cours −
   * 1h30). Voir la spec dans docs/chauffage-sdb.md.
   */
  import { onMount, onDestroy } from 'svelte';
  import { planning } from '$stores/planning.svelte';
  import {
    DAY_LABELS,
    DAY_SHORT,
    fmtHHMM,
    wakeLabelFor,
    abLetterFor,
    type DayMorning,
    type PlanningException
  } from '$utils/planning-derive';
  import BottomSheet from '$components/ui/BottomSheet.svelte';

  const QUICK_HOURS = ['07:00', '08:00', '09:00', '10:00'];

  const now = new Date();
  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const currentLetter = $derived(abLetterFor(todayISO, planning.data));

  onMount(() => {
    planning.hydrate();
  });
  onDestroy(() => {
    planning.flushNow();
  });

  // ─── Affichage d'un jour (pastille) ───
  function dayInfo(week: 'A' | 'B', i: number): { text: string; tone: string } {
    const d = (week === 'A' ? planning.data.weekA : planning.data.weekB)[i];
    if (d.kind === 'start')
      return { text: fmtHHMM(d.start) + (d.halfGroup ? ' ½' : ''), tone: 'start' };
    if (d.kind === 'afternoon') return { text: 'aprèm', tone: 'afternoon' };
    if (d.kind === 'rest') return { text: 'repos', tone: 'rest' };
    return { text: fmtHHMM(planning.data.defaultStart), tone: 'inherit' };
  }

  // ─── Feuille JOUR ───
  let daySheet = $state<{ week: 'A' | 'B'; day: number } | null>(null);
  let dayDraft = $state<{ kind: DayMorning['kind']; start: string; halfGroup: boolean }>({
    kind: 'inherit',
    start: '08:00',
    halfGroup: false
  });
  const dayTitle = $derived(
    daySheet
      ? `${DAY_LABELS[daySheet.day]}${planning.data.abEnabled ? ' · semaine ' + daySheet.week : ''}`
      : ''
  );

  function openDay(week: 'A' | 'B', day: number) {
    const cur = (week === 'A' ? planning.data.weekA : planning.data.weekB)[day];
    dayDraft = {
      kind: cur.kind,
      start: cur.kind === 'start' ? cur.start : planning.data.defaultStart,
      halfGroup: cur.kind === 'start' ? !!cur.halfGroup : false
    };
    daySheet = { week, day };
  }
  function commitDay() {
    if (!daySheet) return;
    let morning: DayMorning;
    if (dayDraft.kind === 'start')
      morning = dayDraft.halfGroup
        ? { kind: 'start', start: dayDraft.start, halfGroup: true }
        : { kind: 'start', start: dayDraft.start };
    else if (dayDraft.kind === 'afternoon') morning = { kind: 'afternoon' };
    else if (dayDraft.kind === 'rest') morning = { kind: 'rest' };
    else morning = { kind: 'inherit' };
    planning.setDayMorning(daySheet.week, daySheet.day, morning);
    daySheet = null;
  }

  // ─── Feuille EXCEPTION (journée spéciale) ───
  let exSheet = $state(false);
  let exEditId = $state<string | null>(null);
  let exDraft = $state<{
    date: string;
    mode: 'start' | 'rest' | 'evening';
    start: string;
    time: string;
    label: string;
  }>({
    date: '',
    mode: 'start',
    start: '08:00',
    time: '18:00',
    label: ''
  });

  function openException(exc?: PlanningException) {
    if (exc) {
      exEditId = exc.id;
      exDraft = {
        date: exc.date,
        mode: !exc.affectsMorning ? 'evening' : exc.morning?.kind === 'start' ? 'start' : 'rest',
        start: exc.morning?.kind === 'start' ? exc.morning.start : '08:00',
        time: exc.time ?? '18:00',
        label: exc.label ?? ''
      };
    } else {
      exEditId = null;
      exDraft = { date: '', mode: 'start', start: '08:00', time: '18:00', label: '' };
    }
    exSheet = true;
  }
  function commitException() {
    if (!exDraft.date) return;
    const id = exEditId ?? crypto.randomUUID();
    const label = exDraft.label.trim() || undefined;
    let exc: PlanningException;
    if (exDraft.mode === 'start')
      exc = {
        id,
        date: exDraft.date,
        type: 'autre',
        affectsMorning: true,
        morning: { kind: 'start', start: exDraft.start },
        label
      };
    else if (exDraft.mode === 'rest')
      exc = {
        id,
        date: exDraft.date,
        type: 'autre',
        affectsMorning: true,
        morning: { kind: 'rest' },
        label
      };
    else
      exc = {
        id,
        date: exDraft.date,
        type: 'reunion',
        affectsMorning: false,
        time: exDraft.time,
        label
      };
    planning.upsertException(exc);
    exSheet = false;
  }

  function fmtDate(iso: string): string {
    return new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
  }
  function excLabel(exc: PlanningException): string {
    if (!exc.affectsMorning) return (exc.label || 'Rendez-vous') + ' (le soir)';
    if (exc.morning?.kind === 'start')
      return (exc.label ? exc.label + ' — ' : '') + 'je commence à ' + fmtHHMM(exc.morning.start);
    return exc.label || 'Pas de collège';
  }

  // ─── Douche du soir ───
  function toggleEveningDay(i: number) {
    const days = planning.data.eveningShower.days;
    planning.data.eveningShower.days = days.includes(i)
      ? days.filter((d) => d !== i)
      : [...days, i].sort((a, b) => a - b);
    planning.save();
  }

  // ─── Période assistante (pense-bête) ───
  let memOpen = $state(false);
  let assistFrom = $state('');
  let assistTo = $state('');
  function addAssistant() {
    if (!assistFrom || !assistTo) return;
    planning.addAssistantPeriod({ id: crypto.randomUUID(), from: assistFrom, to: assistTo });
    assistFrom = '';
    assistTo = '';
  }
</script>

<svelte:head>
  <title>Mes matins — Domo</title>
</svelte:head>

{#snippet weekBlock(week: 'A' | 'B', label: string, accent: string)}
  <div class="mm-week" style="border-color: {accent};">
    <div class="mm-week-head">
      <span class="mm-week-title">{label}</span>
      {#if week === 'B'}
        <button type="button" class="mm-ghost" onclick={() => planning.copyAtoB()}>
          Copier la semaine A
        </button>
      {/if}
    </div>
    <div class="mm-days">
      {#each DAY_SHORT as short, i (i)}
        {@const info = dayInfo(week, i)}
        <button type="button" class="mm-pill" onclick={() => openDay(week, i)}>
          <span class="mm-pill-day">{short}</span>
          <span class="mm-pill-val" data-tone={info.tone}>{info.text}</span>
        </button>
      {/each}
    </div>
  </div>
{/snippet}

<div class="flex flex-col gap-6 py-4">
  <!-- En-tête -->
  <div class="flex flex-col gap-1">
    <a href="/reglages" class="text-[12px] font-medium" style="color: var(--color-primary);">
      ← Réglages
    </a>
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">Mes matins</h1>
      <span
        class="text-[13px] font-medium"
        style="color: {planning.lastError ? 'var(--color-alert)' : 'var(--color-success)'};"
      >
        {#if planning.saving}Enregistrement…{:else if planning.lastError}⚠ non enregistré{:else}Enregistré
          ✓{/if}
      </span>
    </div>
    <p class="text-[13px]" style="color: var(--color-muted-fg);">
      Dites‑moi juste à quelle heure vous commencez le matin : la salle de bain sera chaude pour
      votre réveil, sans que vous ayez à y penser. Cette page ne règle que le chauffage de la salle
      de bain.
    </p>
  </div>

  <!-- Rythme habituel -->
  <section
    class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-5"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <span class="text-[15px]" style="color: var(--color-fg);">
      En général, je commence mes journées à
    </span>
    <div class="flex flex-wrap items-center gap-2">
      <input
        type="time"
        class="mm-time mm-time-lg"
        bind:value={planning.data.defaultStart}
        onchange={() => planning.save()}
      />
      {#each QUICK_HOURS as h (h)}
        <button
          type="button"
          class="mm-chip"
          class:sel={planning.data.defaultStart === h}
          onclick={() => {
            planning.data.defaultStart = h;
            planning.save();
          }}
        >
          {fmtHHMM(h)}
        </button>
      {/each}
    </div>
    <span class="text-[12px]" style="color: var(--color-muted-fg);">
      C'est déjà bon : si vous ne touchez à rien d'autre, on chauffera pour {fmtHHMM(
        planning.data.defaultStart
      )} les jours d'école.
    </span>
  </section>

  <!-- Question A/B -->
  <section class="flex flex-col gap-3">
    <span class="text-[15px]" style="color: var(--color-fg);">
      Votre emploi du temps change‑t‑il une semaine sur deux ?
    </span>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <button
        type="button"
        class="mm-big"
        class:sel={!planning.data.abEnabled}
        onclick={() => planning.setAbEnabled(false)}
      >
        Non, c'est pareil chaque semaine
      </button>
      <button
        type="button"
        class="mm-big"
        class:sel={planning.data.abEnabled}
        onclick={() => planning.setAbEnabled(true)}
      >
        Oui, j'ai une semaine A et une semaine B
      </button>
    </div>

    {#if planning.data.abEnabled}
      <div
        class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-xl)] border p-3"
        style="background: color-mix(in oklch, var(--color-primary) 10%, transparent); border-color: var(--color-primary);"
      >
        <span class="text-[13px]" style="color: var(--color-fg);">
          Cette semaine, vous êtes en <strong>semaine {currentLetter}</strong>.
        </span>
        <button
          type="button"
          class="mm-ghost"
          onclick={() => planning.reanchorThisWeek(currentLetter === 'A' ? 'B' : 'A')}
        >
          Non, je suis en semaine {currentLetter === 'A' ? 'B' : 'A'}
        </button>
      </div>
    {/if}
  </section>

  <!-- Les jours -->
  <section class="flex flex-col gap-3">
    {#if planning.data.abEnabled}
      <div class="grid gap-3 lg:grid-cols-2">
        {@render weekBlock('A', 'Semaine A', 'var(--color-primary)')}
        {@render weekBlock('B', 'Semaine B', 'var(--color-consumption)')}
      </div>
    {:else}
      {@render weekBlock('A', 'Ma semaine', 'var(--color-border)')}
    {/if}
    <span class="text-[12px]" style="color: var(--color-muted-fg);">
      Touchez un jour pour changer son heure, ou le marquer « après‑midi » / « repos ».
    </span>
  </section>

  <!-- Ce qui change parfois -->
  <section class="flex flex-col gap-3">
    <h2
      class="text-[11px] font-semibold tracking-[0.08em] uppercase"
      style="color: var(--color-muted-fg);"
    >
      Ce qui change parfois
    </h2>
    <button type="button" class="mm-add" onclick={() => openException()}>
      + Ajouter une journée spéciale
    </button>
    {#if planning.data.exceptions.length === 0}
      <p class="text-[13px]" style="color: var(--color-muted-fg);">
        Rien de spécial prévu — tout roule.
      </p>
    {:else}
      <div
        class="flex flex-col divide-y rounded-[var(--radius-xl)] border"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        {#each planning.data.exceptions as exc (exc.id)}
          <div class="flex items-center gap-2 px-4 py-3">
            <button
              type="button"
              class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
              onclick={() => openException(exc)}
            >
              <span class="text-[13px] font-semibold capitalize" style="color: var(--color-fg);">
                {fmtDate(exc.date)}
              </span>
              <span class="text-[12px]" style="color: var(--color-muted-fg);">{excLabel(exc)}</span>
            </button>
            <button
              type="button"
              class="mm-del"
              aria-label="Enlever cette journée"
              onclick={() => planning.removeException(exc.id)}
            >
              ×
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Douche du soir -->
  <section
    class="flex flex-col gap-3 rounded-[var(--radius-2xl)] border p-5"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    <label class="flex items-center justify-between gap-3">
      <span class="text-[15px]" style="color: var(--color-fg);">
        Et le soir ? Chauffer aussi pour la douche du soir
      </span>
      <input
        type="checkbox"
        class="mm-switch"
        bind:checked={planning.data.eveningShower.enabled}
        onchange={() => planning.save()}
      />
    </label>
    {#if planning.data.eveningShower.enabled}
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[13px]" style="color: var(--color-muted-fg);"
          >Salle de bain chaude vers</span
        >
        <input
          type="time"
          class="mm-time"
          bind:value={planning.data.eveningShower.targetReady}
          onchange={() => planning.save()}
        />
      </div>
      <div class="flex flex-wrap gap-1.5">
        {#each DAY_SHORT as short, i (i)}
          <button
            type="button"
            class="mm-chip"
            class:sel={planning.data.eveningShower.days.includes(i)}
            onclick={() => toggleEveningDay(i)}
          >
            {short}
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Pour mémoire -->
  <section class="flex flex-col gap-2">
    <button
      type="button"
      class="flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] uppercase"
      style="color: var(--color-muted-fg);"
      onclick={() => (memOpen = !memOpen)}
    >
      Pour mémoire {memOpen ? '▾' : '▸'}
    </button>
    {#if memOpen}
      <div
        class="flex flex-col gap-3 rounded-[var(--radius-xl)] border p-4"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <p class="text-[12px]" style="color: var(--color-muted-fg);">
          Pas besoin de noter les demi‑groupes ni le détail des cours : seule l'heure de votre
          premier cours compte pour la salle de bain.
        </p>
        <span class="text-[13px]" style="color: var(--color-fg);">
          Une assistante m'accompagne (pense‑bête, ça ne change rien au chauffage) :
        </span>
        <div class="flex flex-wrap items-center gap-2">
          <input type="date" class="mm-time" bind:value={assistFrom} />
          <span class="text-[12px]" style="color: var(--color-muted-fg);">au</span>
          <input type="date" class="mm-time" bind:value={assistTo} />
          <button type="button" class="mm-add" onclick={addAssistant}>Ajouter</button>
        </div>
        {#each planning.data.assistantPeriods as p (p.id)}
          <div
            class="flex items-center justify-between gap-2 text-[12px]"
            style="color: var(--color-muted-fg);"
          >
            <span>du {fmtDate(p.from)} au {fmtDate(p.to)}</span>
            <button
              type="button"
              class="mm-del"
              aria-label="Enlever"
              onclick={() => planning.removeAssistantPeriod(p.id)}>×</button
            >
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <div class="h-2"></div>
</div>

<!-- ═══ Feuille : modifier un jour ═══ -->
<BottomSheet open={daySheet !== null} title={dayTitle} onClose={() => (daySheet = null)}>
  {#snippet children()}
    <div class="mm-choices">
      <button
        type="button"
        class="mm-choice"
        class:sel={dayDraft.kind === 'start'}
        onclick={() => (dayDraft.kind = 'start')}
      >
        Ce jour‑là, je commence à…
      </button>
      <button
        type="button"
        class="mm-choice"
        class:sel={dayDraft.kind === 'afternoon'}
        onclick={() => (dayDraft.kind = 'afternoon')}
      >
        Pas le matin — je commence l'après‑midi
      </button>
      <button
        type="button"
        class="mm-choice"
        class:sel={dayDraft.kind === 'rest'}
        onclick={() => (dayDraft.kind = 'rest')}
      >
        Repos — pas de collège ce jour‑là
      </button>
      <button
        type="button"
        class="mm-choice"
        class:sel={dayDraft.kind === 'inherit'}
        onclick={() => (dayDraft.kind = 'inherit')}
      >
        Comme d'habitude ({fmtHHMM(planning.data.defaultStart)})
      </button>
    </div>

    {#if dayDraft.kind === 'start'}
      <div class="flex flex-wrap items-center gap-2">
        <input type="time" class="mm-time mm-time-lg" bind:value={dayDraft.start} />
        {#each QUICK_HOURS as h (h)}
          <button
            type="button"
            class="mm-chip"
            class:sel={dayDraft.start === h}
            onclick={() => (dayDraft.start = h)}
          >
            {fmtHHMM(h)}
          </button>
        {/each}
      </div>
      <label class="flex items-center gap-2 text-[13px]" style="color: var(--color-muted-fg);">
        <input type="checkbox" bind:checked={dayDraft.halfGroup} />
        C'est un cours en demi‑groupe (facultatif)
      </label>
      <p class="text-[13px]" style="color: var(--color-fg);">
        🚿 Salle de bain prête vers <strong
          >{wakeLabelFor(dayDraft.start, planning.data.comfort)}</strong
        >, pour votre réveil.
      </p>
    {/if}
  {/snippet}
  {#snippet footer()}
    <button type="button" class="mm-cancel" onclick={() => (daySheet = null)}>Annuler</button>
    <button type="button" class="mm-validate" onclick={commitDay}>C'est noté</button>
  {/snippet}
</BottomSheet>

<!-- ═══ Feuille : journée spéciale ═══ -->
<BottomSheet open={exSheet} title="Une journée spéciale" onClose={() => (exSheet = false)}>
  {#snippet children()}
    <label class="flex flex-col gap-1 text-[13px]" style="color: var(--color-muted-fg);">
      Quel jour ?
      <input type="date" class="mm-time" bind:value={exDraft.date} />
    </label>
    <div class="mm-choices">
      <button
        type="button"
        class="mm-choice"
        class:sel={exDraft.mode === 'start'}
        onclick={() => (exDraft.mode = 'start')}
      >
        Ce jour‑là, je commence à une autre heure
      </button>
      <button
        type="button"
        class="mm-choice"
        class:sel={exDraft.mode === 'rest'}
        onclick={() => (exDraft.mode = 'rest')}
      >
        Pas de collège ce jour‑là (sortie, journée libérée…)
      </button>
      <button
        type="button"
        class="mm-choice"
        class:sel={exDraft.mode === 'evening'}
        onclick={() => (exDraft.mode = 'evening')}
      >
        Un rendez‑vous le soir (réunion, conseil…)
      </button>
    </div>

    {#if exDraft.mode === 'start'}
      <div class="flex flex-wrap items-center gap-2">
        <input type="time" class="mm-time mm-time-lg" bind:value={exDraft.start} />
        {#each QUICK_HOURS as h (h)}
          <button
            type="button"
            class="mm-chip"
            class:sel={exDraft.start === h}
            onclick={() => (exDraft.start = h)}
          >
            {fmtHHMM(h)}
          </button>
        {/each}
      </div>
      <p class="text-[13px]" style="color: var(--color-fg);">
        On chauffera pour que vous soyez prête vers <strong
          >{wakeLabelFor(exDraft.start, planning.data.comfort)}</strong
        >.
      </p>
    {:else if exDraft.mode === 'evening'}
      <div class="flex flex-wrap items-center gap-2">
        <input type="time" class="mm-time" bind:value={exDraft.time} />
        <input
          type="text"
          class="mm-text"
          placeholder="Réunion parents-profs…"
          bind:value={exDraft.label}
        />
      </div>
      <p class="text-[13px]" style="color: var(--color-muted-fg);">
        Pas d'inquiétude : un rendez‑vous le soir ne change pas le chauffage du matin.
      </p>
    {:else}
      <p class="text-[13px]" style="color: var(--color-muted-fg);">
        Ce jour‑là, pas de chauffe le matin.
      </p>
    {/if}
  {/snippet}
  {#snippet footer()}
    <button type="button" class="mm-cancel" onclick={() => (exSheet = false)}>Annuler</button>
    <button type="button" class="mm-validate" disabled={!exDraft.date} onclick={commitException}>
      C'est noté
    </button>
  {/snippet}
</BottomSheet>

<style>
  /* Inputs heure/date/texte */
  .mm-time,
  .mm-text {
    font-size: 16px; /* anti-zoom iOS */
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 0.45rem 0.7rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
  }
  .mm-time:focus,
  .mm-text:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .mm-time-lg {
    font-size: 22px;
    font-weight: 700;
    padding: 0.5rem 0.9rem;
  }

  /* Pastilles rapides */
  .mm-chip {
    padding: 0.4rem 0.7rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .mm-chip.sel {
    border-color: var(--color-primary);
    background: color-mix(in oklch, var(--color-primary) 16%, transparent);
    color: var(--color-primary);
  }

  /* Gros boutons (A/B) */
  .mm-big {
    min-height: 64px;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-border);
    background: var(--color-card);
    color: var(--color-fg);
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 160ms ease;
  }
  .mm-big.sel {
    border-color: var(--color-primary);
    background: color-mix(in oklch, var(--color-primary) 12%, transparent);
  }

  /* Bloc semaine */
  .mm-week {
    border-left-width: 4px;
    border-left-style: solid;
    border-radius: var(--radius-xl);
    padding: 0.75rem 0.75rem 1rem;
    background: var(--color-card);
  }
  .mm-week-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.6rem;
    padding-left: 0.25rem;
  }
  .mm-week-title {
    font-size: 13px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .mm-days {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 0.35rem;
  }
  .mm-pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    min-height: 56px;
    padding: 0.4rem 0.15rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    cursor: pointer;
  }
  .mm-pill-day {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }
  .mm-pill-val {
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: center;
    line-height: 1.1;
  }
  .mm-pill-val[data-tone='start'] {
    color: var(--color-primary);
  }
  .mm-pill-val[data-tone='inherit'] {
    color: var(--color-muted-fg);
    font-weight: 600;
  }
  .mm-pill-val[data-tone='afternoon'] {
    color: var(--color-consumption);
  }
  .mm-pill-val[data-tone='rest'] {
    color: var(--color-muted-fg);
    opacity: 0.7;
    font-weight: 600;
  }

  /* Boutons d'ajout / fantôme / suppression */
  .mm-add {
    align-self: flex-start;
    padding: 0.5rem 0.9rem;
    border-radius: var(--radius-pill);
    border: 1px dashed var(--color-border-strong);
    background: transparent;
    color: var(--color-primary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .mm-ghost {
    padding: 0.3rem 0.7rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-muted-fg);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .mm-del {
    width: 1.85rem;
    height: 1.85rem;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-alert);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  /* Choix dans les feuilles */
  .mm-choices {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .mm-choice {
    text-align: left;
    padding: 0.7rem 0.9rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }
  .mm-choice.sel {
    border-color: var(--color-primary);
    background: color-mix(in oklch, var(--color-primary) 14%, transparent);
    color: var(--color-primary);
  }

  /* Pied de feuille */
  .mm-cancel {
    flex: 1;
    padding: 0.7rem;
    border-radius: var(--radius-pill);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-muted-fg);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }
  .mm-validate {
    flex: 2;
    padding: 0.7rem;
    border-radius: var(--radius-pill);
    border: none;
    background: var(--color-primary);
    color: oklch(0.98 0 0);
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
  }
  .mm-validate:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .mm-switch {
    width: 1.2rem;
    height: 1.2rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .mm-big {
      transition: none;
    }
  }
</style>
