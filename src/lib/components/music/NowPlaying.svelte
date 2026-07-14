<script lang="ts">
  /**
   * Feuille « Now Playing » plein écran, façon PlexAmp : la POCHETTE FLOUTÉE
   * remplit tout l'écran (voile sombre pour le contraste, masquée si
   * prefers-reduced-transparency), grande pochette nette au centre, indicateur
   * d'écoute animé (gated Animations + reduced-motion), contrôles, file
   * d'attente — et lien « Supprimer ce morceau » sur la piste EN COURS
   * (confirmation obligatoire, puis la lecture enchaîne sur la suivante).
   *
   * Pendant un drag du curseur de progression, l'affichage suit le doigt
   * (`scrub`) et on ne commet le seek qu'au relâché — sinon timeupdate ferait
   * sauter le curseur sous le doigt (même principe que les sliders WLED).
   */
  import { plex, player, fmtDuration, plexImg } from '$stores/plex.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import AlbumCover from './AlbumCover.svelte';

  let scrub = $state<number | null>(null);
  const shown = $derived(scrub ?? player.currentTime);
  const remaining = $derived(Math.max(0, player.duration - shown));

  function fmtS(seconds: number): string {
    return fmtDuration(seconds * 1000);
  }

  const upNext = $derived(player.queue.slice(player.index + 1, player.index + 21));
  const backdropUrl = $derived(plexImg(player.current?.thumb, 800));
  const eqOn = $derived(player.playing && preferences.animationsEnabled);

  // ── Suppression de la piste en cours ─────────────────────────────────────
  let confirmOpen = $state(false);
  let deleting = $state(false);
  let delError = $state<string | null>(null);

  async function deleteCurrent() {
    const t = player.current;
    if (!t || deleting) return;
    deleting = true;
    delError = null;
    try {
      await plex.deleteItem(t.key);
      confirmOpen = false;
      player.removeAt(player.index);
    } catch (e) {
      delError = (e as Error).message;
    }
    deleting = false;
  }
</script>

{#if player.sheetOpen && player.current}
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Lecteur">
    {#if backdropUrl}
      <!-- Fond PlexAmp : la pochette courante, floutée plein écran + voile -->
      <div
        class="backdrop"
        style="background-image: url('{backdropUrl}');"
        aria-hidden="true"
      ></div>
      <div class="veil" aria-hidden="true"></div>
    {:else}
      <div class="ambient" aria-hidden="true"></div>
    {/if}

    <div class="content">
      <button
        class="grab-zone"
        onclick={() => (player.sheetOpen = false)}
        aria-label="Fermer le lecteur"
      >
        <span class="grab" aria-hidden="true"></span>
      </button>

      {#if player.context}
        <p class="context">En lecture · {player.context}</p>
      {/if}

      <div class="cover">
        <AlbumCover
          thumb={player.current.thumb}
          title={player.current.album}
          size={800}
          radius={26}
        />
      </div>

      <div class="meta">
        <div class="title">
          {#if eqOn}
            <span class="eq" aria-label="En cours de lecture"><i></i><i></i><i></i></span>
          {/if}
          <span>{player.current.title}</span>
        </div>
        <div class="artist">{player.current.artist}</div>
        {#if player.current.album}
          <div class="album">{player.current.album}</div>
        {/if}
        <button class="track-del" onclick={() => (confirmOpen = true)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" /></svg
          >
          Supprimer ce morceau
        </button>
      </div>

      <div class="progress">
        <input
          type="range"
          min="0"
          max={player.duration || 1}
          step="1"
          value={shown}
          aria-label="Position dans le morceau"
          oninput={(e) => (scrub = Number(e.currentTarget.value))}
          onchange={(e) => {
            player.seek(Number(e.currentTarget.value));
            scrub = null;
          }}
        />
        <div class="times"><span>{fmtS(shown)}</span><span>−{fmtS(remaining)}</span></div>
      </div>

      <div class="controls">
        <button
          class="small"
          class:on={player.shuffle}
          onclick={() => player.toggleShuffle()}
          aria-label="Lecture aléatoire"
          aria-pressed={player.shuffle}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7M16 21h5v-5M21 21l-6-6M3 3l6 6" /></svg
          >
        </button>
        <button class="skip" onclick={() => player.prev()} aria-label="Piste précédente">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"
            ><path d="M19 20 9 12l10-8zM7 4H5v16h2z" /></svg
          >
        </button>
        <button
          class="play"
          onclick={() => player.toggle()}
          aria-label={player.playing ? 'Pause' : 'Lecture'}
        >
          {#if player.playing}
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"
              ><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg
            >
          {:else}
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"
              ><path d="M7 4l13 8-13 8z" /></svg
            >
          {/if}
        </button>
        <button class="skip" onclick={() => player.next()} aria-label="Piste suivante">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"
            ><path d="M5 4l10 8-10 8zM17 4h2v16h-2z" /></svg
          >
        </button>
        <button
          class="small"
          class:on={player.repeat !== 'off'}
          onclick={() => player.cycleRepeat()}
          aria-label="Répéter ({player.repeat === 'one'
            ? 'ce morceau'
            : player.repeat === 'all'
              ? 'tout'
              : 'désactivé'})"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path
              d="M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3"
            /></svg
          >
          {#if player.repeat === 'one'}<span class="one">1</span>{/if}
        </button>
      </div>

      {#if player.lastError}
        <p class="error">{player.lastError}</p>
      {/if}

      <div class="queue">
        <div class="queue-head">
          <span>À suivre · {upNext.length}</span>
          <button class="stop" onclick={() => player.clear()}>Arrêter</button>
        </div>
        {#each upNext as t, i (t.key)}
          <button class="qrow" onclick={() => player.jumpTo(player.index + 1 + i)}>
            <span class="qthumb"
              ><AlbumCover thumb={t.thumb} title={t.album} size={96} radius={8} /></span
            >
            <span class="qmeta">
              <span class="qt">{t.title}</span>
              <span class="qa">{t.artist}</span>
            </span>
            <span class="qdur">{fmtDuration(t.duration)}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Confirmation de suppression (jamais de suppression sèche) -->
    {#if confirmOpen}
      <div class="modal" role="dialog" aria-modal="true" aria-label="Confirmer la suppression">
        <div
          class="modal-card"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          <p class="modal-title">Supprimer « {player.current.title} » ?</p>
          <p class="modal-detail">
            Le morceau sera effacé du disque de musique. Cette action est définitive.
          </p>
          {#if delError}<p class="modal-error">{delError}</p>{/if}
          <div class="modal-btns">
            <button
              class="modal-btn"
              onclick={() => {
                confirmOpen = false;
                delError = null;
              }}
              disabled={deleting}>Annuler</button
            >
            <button class="modal-btn danger" onclick={deleteCurrent} disabled={deleting}>
              {deleting ? 'Suppression…' : 'Supprimer'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 80;
    /* Lecteur TOUJOURS sombre (façon PlexAmp), quel que soit le thème : le texte
       clair et le voile sont calés sur ce fond indigo — pas sur --color-bg. */
    background: oklch(0.205 0.04 286);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  /* ── Fond PlexAmp : pochette floutée + voile de contraste ─────────────── */
  .backdrop {
    position: fixed;
    inset: -48px;
    background-size: cover;
    background-position: center;
    filter: blur(64px) saturate(170%) brightness(0.55);
    transform: scale(1.2);
    pointer-events: none;
  }
  .veil {
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(
      180deg,
      oklch(0.185 0.04 286 / 0.3),
      oklch(0.185 0.04 286 / 0.55) 55%,
      oklch(0.185 0.04 286 / 0.78)
    );
  }
  /* Lisibilité d'abord : sans transparence, fond uni (le voile devient inutile). */
  @media (prefers-reduced-transparency: reduce) {
    .backdrop,
    .veil {
      display: none;
    }
  }
  .ambient {
    position: fixed;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(70% 50% at 50% 12%, oklch(0.75 0.23 350 / 0.24), transparent 70%),
      radial-gradient(50% 40% at 8% 80%, oklch(0.62 0.27 293 / 0.22), transparent 70%),
      radial-gradient(50% 45% at 92% 92%, oklch(0.82 0.24 152 / 0.16), transparent 70%);
  }

  .content {
    position: relative;
    max-width: 440px;
    margin: 0 auto;
    padding: calc(8px + env(safe-area-inset-top)) 24px calc(30px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
  }
  .grab-zone {
    background: none;
    border: none;
    padding: 10px 0 12px;
    width: 100%;
  }
  .grab {
    display: block;
    width: 42px;
    height: 5px;
    border-radius: 99px;
    background: oklch(0.96 0.013 286 / 0.4);
    margin: 0 auto;
  }
  .context {
    text-align: center;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: oklch(0.96 0.013 286 / 0.65);
    margin: 0 0 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cover {
    border-radius: 26px;
    box-shadow:
      0 26px 52px -20px oklch(0.13 0.03 286 / 0.75),
      0 8px 20px -8px oklch(0.13 0.03 286 / 0.5);
  }

  .meta {
    text-align: center;
    margin: 22px 0 2px;
  }
  .title {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-size: 23px;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: oklch(0.985 0.008 286);
  }
  .title > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artist {
    color: oklch(0.96 0.013 286 / 0.85);
    font-size: 15.5px;
    font-weight: 600;
    margin-top: 4px;
  }
  .album {
    color: oklch(0.96 0.013 286 / 0.6);
    font-size: 13px;
    margin-top: 2px;
  }

  .eq {
    display: inline-flex;
    align-items: flex-end;
    gap: 2.5px;
    height: 16px;
    flex: 0 0 auto;
  }
  .eq i {
    width: 3.5px;
    border-radius: 2px;
    background: var(--color-magenta);
    box-shadow: 0 0 8px oklch(0.75 0.23 350 / 0.7);
    animation: eq 0.9s ease-in-out infinite;
  }
  .eq i:nth-child(1) {
    height: 8px;
  }
  .eq i:nth-child(2) {
    height: 16px;
    animation-delay: 0.25s;
  }
  .eq i:nth-child(3) {
    height: 11px;
    animation-delay: 0.5s;
  }
  @keyframes eq {
    0%,
    100% {
      transform: scaleY(1);
    }
    50% {
      transform: scaleY(0.4);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .eq i {
      animation: none;
    }
  }

  .track-del {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    background: oklch(0.704 0.17 22.2 / 0.14);
    border: 1px solid oklch(0.704 0.17 22.2 / 0.4);
    color: oklch(0.82 0.13 22);
    border-radius: var(--radius-pill, 999px);
    padding: 7px 14px;
    font-weight: 600;
    font-size: 12.5px;
  }

  .progress {
    margin: 16px 0 4px;
  }
  input[type='range'] {
    width: 100%;
    height: 28px;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 99px;
    background: oklch(0.96 0.013 286 / 0.25);
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: oklch(0.985 0.008 286);
    margin-top: -6px;
    box-shadow: 0 2px 8px oklch(0.13 0.03 286 / 0.6);
  }
  .times {
    display: flex;
    justify-content: space-between;
    color: oklch(0.96 0.013 286 / 0.65);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 10px 2px 0;
  }
  .controls button {
    background: none;
    border: none;
    color: oklch(0.985 0.008 286);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .small {
    position: relative;
    width: 44px;
    height: 44px;
    color: oklch(0.96 0.013 286 / 0.6) !important;
  }
  .small.on {
    color: var(--color-magenta) !important;
  }
  .one {
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 10px;
    font-weight: 800;
  }
  .skip {
    width: 56px;
    height: 56px;
  }
  .play {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    background: var(--color-magenta) !important;
    color: oklch(0.18 0.05 350) !important;
    box-shadow:
      0 0 30px -4px oklch(0.75 0.23 350 / 0.6),
      inset 2px 3px 6px -2px oklch(1 0 0 / 0.5);
  }

  .error {
    color: var(--color-alert);
    text-align: center;
    font-size: 13.5px;
    margin: 12px 0 0;
  }

  .queue {
    margin-top: 24px;
  }
  .queue-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: oklch(0.96 0.013 286 / 0.65);
    margin: 0 2px 8px;
  }
  .stop {
    background: none;
    border: 1px solid oklch(0.96 0.013 286 / 0.3);
    color: oklch(0.96 0.013 286 / 0.75);
    border-radius: 999px;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    text-transform: none;
    letter-spacing: normal;
  }
  .qrow {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    background: none;
    border: none;
    padding: 8px 2px;
    color: oklch(0.985 0.008 286);
    font: inherit;
    text-align: left;
    border-radius: 12px;
  }
  .qthumb {
    width: 40px;
    height: 40px;
    flex: 0 0 40px;
  }
  .qmeta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .qt {
    font-weight: 600;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qa {
    color: oklch(0.96 0.013 286 / 0.6);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qdur {
    color: oklch(0.96 0.013 286 / 0.6);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }

  /* ── Confirmation ──────────────────────────────────────────────────────── */
  .modal {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: oklch(0.13 0.03 286 / 0.6);
  }
  .modal-card {
    width: 100%;
    max-width: 360px;
    border: 1px solid;
    border-radius: var(--radius-3xl, 28px);
    padding: 20px;
    text-align: center;
  }
  .modal-title {
    font-size: 16px;
    font-weight: 700;
    margin: 0;
  }
  .modal-detail {
    color: var(--color-muted-fg);
    font-size: 13.5px;
    margin: 8px 0 16px;
  }
  .modal-error {
    color: var(--color-alert);
    font-size: 13px;
    margin: 0 0 12px;
  }
  .modal-btns {
    display: flex;
    gap: 10px;
  }
  .modal-btn {
    flex: 1;
    border-radius: 16px;
    padding: 14px 0;
    font-weight: 700;
    font-size: 15px;
    border: 1px solid var(--color-border);
    background: none;
    color: var(--color-fg);
  }
  .modal-btn.danger {
    background: var(--color-alert);
    border-color: transparent;
    color: oklch(0.98 0.01 27);
    box-shadow: 0 0 20px -6px oklch(0.704 0.17 22.2 / 0.6);
  }
</style>
