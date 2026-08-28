<script lang="ts">
  /**
   * Réglage des effets lumineux qui accompagnent la musique — panneau PARTAGÉ.
   *
   * Un seul endroit décrit ce réglage, pour deux points d'entrée : la feuille
   * de l'éclairage terrasse (on part de la lumière) et le lecteur de la page
   * Musique (on part du morceau). Deux copies auraient divergé au premier
   * style ajouté.
   *
   * PAR LIGNE : la terrasse porte deux rubans de nature différente — « SàM
   * d'Été » éclaire la table, « Store » borde les bras du store banne. Faire
   * danser le store pendant que la table reste en blanc chaud est l'usage
   * courant ; l'état global d'avant l'interdisait. Chaque ligne a donc son
   * style, et « Ne suit pas » est simplement le premier choix de la grille —
   * une décision à la fois, pas un réglage de participation séparé.
   *
   * Une seule ligne (ou module non découpé) : pas d'onglets, la grille pilote
   * directement le style global. L'écran ne montre jamais une complexité que
   * l'installation n'a pas.
   */
  import { wled } from '$stores/wled.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';
  import { WLED_MUSIC_STYLES } from '$lib/wled/music-styles';
  import { haptic } from '$utils/haptic';

  interface Props {
    /** Rendu compact (feuille du lecteur) : masque le rappel d'aide. */
    compact?: boolean;
  }
  let { compact = false }: Props = $props();

  const segs = $derived(wled.segments);
  const multi = $derived(segs.length > 1);
  const ids = $derived(segs.map((s) => s.id));

  /** Ligne en cours de réglage (mode multi-lignes). */
  let editing = $state(0);
  $effect(() => {
    if (segs.length && !segs.some((s) => s.id === editing)) editing = segs[0].id;
  });

  /** Style affiché par la grille : celui de la ligne réglée, ou le global. */
  const current = $derived(multi ? wledMusic.lineStyle(editing) : wledMusic.style);

  /** Résumé d'une ligne pour son onglet (« Cascade », « — »). */
  function lineSummary(id: number): string {
    const k = wledMusic.lineStyle(id);
    if (k === null) return '—';
    return WLED_MUSIC_STYLES.find((s) => s.key === k)?.label ?? k;
  }

  function pick(key: string | null): void {
    haptic('light');
    if (!multi) {
      if (key !== null) wledMusic.setStyle(key);
      return;
    }
    wledMusic.setLineStyle(editing, key, ids);
  }

  // Groupes de la grille : la nature de la réactivité se dit, sinon on cherche
  // des fréquences dans un effet qui ne suit que le volume.
  const GROUPS = [
    { kind: 'freq', title: 'Réagit aux fréquences' },
    { kind: 'vol', title: 'Réagit au volume' }
  ] as const;
</script>

<div class="mlp">
  <!-- Interrupteur global : le mode musique lui-même. -->
  <div class="mlp-row">
    <span class="mlp-title">Suivre la musique</span>
    <label class="toggle-pill" aria-label="Suivre la musique">
      <input
        type="checkbox"
        checked={wledMusic.enabled}
        onchange={(e) => {
          haptic('medium');
          wledMusic.setEnabled((e.currentTarget as HTMLInputElement).checked);
        }}
      />
      <span class="toggle-pill-knob"></span>
    </label>
  </div>

  {#if wledMusic.enabled && wledMusic.beatError}
    <!-- Un suivi qui ne suit pas doit le DIRE (leçon du 28/08 : battements
         refusés en silence pendant des heures, ruban figé, zéro indice). -->
    <p class="mlp-error">La lumière ne reçoit pas la musique : {wledMusic.beatError}</p>
  {/if}
  {#if !wledMusic.enabled}
    <p class="mlp-hint">
      Le ruban de la terrasse suivra le morceau en cours, quel que soit l'appareil qui le joue.
    </p>
  {:else}
    {#if multi}
      <!-- Quelle ligne on règle. Le résumé sous le nom évite d'ouvrir chaque
           onglet pour savoir ce que fait l'autre ruban. -->
      <div class="mlp-lines" role="tablist" aria-label="Quelle ligne régler">
        {#each segs as s (s.id)}
          <button
            type="button"
            class="mlp-line"
            class:active={editing === s.id}
            role="tab"
            aria-selected={editing === s.id}
            onclick={() => {
              haptic('light');
              editing = s.id;
            }}
          >
            <span class="mlp-line-name">{s.name}</span>
            <span class="mlp-line-sum" class:off={wledMusic.lineStyle(s.id) === null}>
              {lineSummary(s.id)}
            </span>
          </button>
        {/each}
      </div>
    {/if}

    <div role="radiogroup" aria-label="Style musical" class="mlp-styles">
      {#if multi}
        <!-- « Ne suit pas » : premier choix de la grille, pas un réglage à
             part — régler une ligne reste UN geste. -->
        <div class="chip-grid">
          <button
            type="button"
            class="chip"
            class:active={current === null}
            role="radio"
            aria-checked={current === null}
            onclick={() => pick(null)}
          >
            Ne suit pas
          </button>
        </div>
      {/if}
      {#each GROUPS as grp (grp.kind)}
        <span class="mlp-group">{grp.title}</span>
        <div class="chip-grid">
          {#each WLED_MUSIC_STYLES.filter((s) => s.kind === grp.kind || (grp.kind === 'freq' && s.kind === 'ambiance')) as st (st.key)}
            <button
              type="button"
              class="chip"
              class:active={current === st.key}
              role="radio"
              aria-checked={current === st.key}
              title={st.hint}
              onclick={() => pick(st.key)}
            >
              {st.label}
            </button>
          {/each}
        </div>
      {/each}
    </div>

    {#if multi && !compact}
      <p class="mlp-hint">
        Chaque ligne garde son propre effet : le store peut danser pendant que la table reste en
        lumière fixe.
      </p>
    {/if}
  {/if}
</div>

<style>
  .mlp {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .mlp-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .mlp-title {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .mlp-hint {
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--color-muted-fg);
  }
  .mlp-error {
    font-size: 12.5px;
    line-height: 1.45;
    font-weight: 600;
    color: oklch(0.62 0.19 27);
  }

  /* ─── Onglets de ligne ─── */
  .mlp-lines {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 8px;
  }
  .mlp-line {
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* Cible tactile ≥ 44 pt (HIG). */
    min-height: 44px;
    padding: 7px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-card-hover);
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .mlp-line.active {
    border-color: var(--color-primary);
    background: var(--color-primary-muted, var(--color-card-hover));
  }
  .mlp-line:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
  .mlp-line-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mlp-line-sum {
    font-size: 11px;
    color: var(--color-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mlp-line-sum.off {
    color: var(--color-muted-fg);
  }

  .mlp-styles {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mlp-group {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--color-muted-fg);
  }
  .chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    /* Cible tactile ≥ 44 pt en hauteur totale (padding compris). */
    min-height: 34px;
    padding: 7px 12px;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-card-hover);
    color: var(--color-fg);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .chip.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .chip:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* ─── Interrupteur (toggle-pill iOS, 44×24) ─── */
  .toggle-pill {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .toggle-pill input {
    position: absolute;
    inset: 0;
    z-index: 1;
    margin: 0;
    cursor: pointer;
    opacity: 0;
  }
  .toggle-pill-knob {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast) var(--ease-default);
  }
  .toggle-pill-knob::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: oklch(0.99 0.004 286);
    box-shadow: 0 1px 2px oklch(0.1 0.01 286 / 0.18);
    transition: transform var(--duration-normal) var(--ease-spring);
  }
  .toggle-pill input:checked + .toggle-pill-knob {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .toggle-pill input:checked + .toggle-pill-knob::after {
    transform: translateX(20px);
  }
  .toggle-pill input:focus-visible + .toggle-pill-knob {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle-pill-knob,
    .toggle-pill-knob::after {
      transition: none;
    }
  }
</style>
