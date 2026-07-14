<script lang="ts">
  /**
   * Feuille « Now Playing » plein écran (ouverte depuis le mini-player) :
   * grande pochette, progression scrubbable, contrôles (aléatoire / précédent /
   * lecture / suivant / répéter) et file d'attente « À suivre ».
   *
   * Pendant un drag du curseur de progression, l'affichage suit le doigt
   * (`scrub`) et on ne commet le seek qu'au relâché — sinon timeupdate ferait
   * sauter le curseur sous le doigt (même principe que les sliders WLED).
   */
  import { player, fmtDuration } from '$stores/plex.svelte';
  import AlbumCover from './AlbumCover.svelte';

  let scrub = $state<number | null>(null);
  const shown = $derived(scrub ?? player.currentTime);
  const remaining = $derived(Math.max(0, player.duration - shown));

  function fmtS(seconds: number): string {
    return fmtDuration(seconds * 1000);
  }

  const upNext = $derived(player.queue.slice(player.index + 1, player.index + 21));
</script>

{#if player.sheetOpen && player.current}
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Lecteur">
    <div class="ambient" aria-hidden="true"></div>
    <div class="content">
      <button
        class="grab-zone"
        onclick={() => (player.sheetOpen = false)}
        aria-label="Fermer le lecteur"
      >
        <span class="grab" aria-hidden="true"></span>
      </button>

      <div class="cover">
        <AlbumCover
          thumb={player.current.thumb}
          title={player.current.album}
          size={800}
          radius={28}
        />
      </div>

      <div class="meta">
        <div class="title">{player.current.title}</div>
        <div class="artist">
          {player.current.artist}{player.current.album ? ` · ${player.current.album}` : ''}
        </div>
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
  </div>
{/if}

<style>
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: var(--color-bg);
    overflow-y: auto;
    overscroll-behavior: contain;
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
    padding: 10px 0 16px;
    width: 100%;
  }
  .grab {
    display: block;
    width: 42px;
    height: 5px;
    border-radius: 99px;
    background: var(--color-border);
    margin: 0 auto;
  }
  .cover {
    box-shadow: 0 22px 44px -18px oklch(0.75 0.23 350 / 0.4);
    border-radius: 28px;
  }
  .meta {
    text-align: center;
    margin: 24px 0 4px;
  }
  .title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .artist {
    color: var(--color-muted-fg);
    font-size: 15px;
    margin-top: 3px;
  }

  .progress {
    margin: 18px 0 4px;
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
    background: oklch(0.52 0.06 286 / 0.45);
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--color-fg);
    margin-top: -6px;
    box-shadow: 0 2px 8px oklch(0.15 0.03 286 / 0.5);
  }
  .times {
    display: flex;
    justify-content: space-between;
    color: var(--color-muted-fg);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 12px 2px 0;
  }
  .controls button {
    background: none;
    border: none;
    color: var(--color-fg);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .small {
    position: relative;
    width: 44px;
    height: 44px;
    color: var(--color-muted-fg) !important;
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
    margin-top: 26px;
  }
  .queue-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
    margin: 0 2px 8px;
  }
  .stop {
    background: none;
    border: 1px solid var(--color-border);
    color: var(--color-muted-fg);
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
    color: inherit;
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
    color: var(--color-muted-fg);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qdur {
    color: var(--color-muted-fg);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
  }
</style>
