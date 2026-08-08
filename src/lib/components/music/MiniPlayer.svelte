<script lang="ts">
  /**
   * Mini-player GLOBAL (monté dans +layout) : n'apparaît QUE si CET appareil a
   * une file de lecture (`player.current`) — jamais parce qu'une autre
   * tablette de la maison joue quelque chose. Il survit à la pause : c'est de
   * là qu'on relance, comme dans tous les lecteurs. « Arrêter » (feuille Now
   * Playing) vide la file et le fait disparaître.
   *
   * Flotte au-dessus de la TabBar sur iPhone, en bas de la zone de contenu (à
   * droite de la sidebar) sur iPad/desktop. Tap sur le corps → feuille Now
   * Playing plein écran. La musique vit dans le store `player` (élément audio
   * module-level), donc survit aux navigations et au pager.
   *
   * OPAQUE, contrairement aux cartes : il flotte AU-DESSUS du contenu, pas
   * posé dessus — un fond translucide laissait lire le texte de la page à
   * travers le titre du morceau. Le fond composé
   * (`linear-gradient(card, card), bg`) échappe volontairement au sélecteur
   * `[style*='background: var(--color-card)']` d'app.css qui pose le verre ;
   * l'ombre du verre est donc reposée explicitement dans le style ci-dessous.
   * La hauteur qu'il occupe est déclarée par `--mini-h` (cf. +layout) pour que
   * le bas des pages reste atteignable.
   */
  import { player } from '$stores/plex.svelte';
  import AlbumCover from './AlbumCover.svelte';
  import NowPlaying from './NowPlaying.svelte';

  const progress = $derived(
    player.duration > 0 ? Math.min(1, player.currentTime / player.duration) : 0
  );
</script>

{#if player.current}
  <div
    class="mini border"
    style="background: linear-gradient(var(--color-card), var(--color-card)), var(--color-bg); border-color: var(--color-border);"
    role="region"
    aria-label="Lecture en cours"
  >
    <button
      class="body"
      onclick={() => (player.sheetOpen = true)}
      aria-label="Ouvrir le lecteur plein écran"
    >
      <span class="thumb"
        ><AlbumCover
          thumb={player.current.thumb}
          title={player.current.album}
          size={96}
          radius={12}
        /></span
      >
      <span class="meta">
        <span class="t">{player.current.title}</span>
        <!-- L'erreur prend la place de l'artiste : sans ça, un morceau qui ne
             démarre pas ne dit RIEN ici, et il fallait ouvrir le lecteur pour
             comprendre pourquoi. -->
        {#if player.lastError}
          <span class="err">{player.lastError}</span>
        {:else}
          <span class="a">{player.current.artist}</span>
        {/if}
      </span>
    </button>
    <button
      class="ctl"
      onclick={() => player.toggle()}
      aria-label={player.playing ? 'Pause' : 'Lecture'}
    >
      {#if player.playing}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"
          ><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg
        >
      {:else}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"
          ><path d="M7 4l13 8-13 8z" /></svg
        >
      {/if}
    </button>
    <button class="ctl" onclick={() => player.next()} aria-label="Piste suivante">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"
        ><path d="M5 4l10 8-10 8zM17 4h2v16h-2z" /></svg
      >
    </button>
    <div class="bar" aria-hidden="true"><i style="width: {progress * 100}%"></i></div>
  </div>
{/if}

<NowPlaying />

<style>
  .mini {
    position: fixed;
    z-index: 40;
    left: 12px;
    right: 12px;
    bottom: calc(60px + env(safe-area-inset-bottom) + 10px);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 10px 10px 8px;
    border-radius: 18px;
    /* Reposée à la main : le fond opaque sort du sélecteur centralisé d'app.css
       qui, lui, apporte l'ombre du verre. */
    box-shadow: var(--shadow-md);
    /* Couche compositeur dédiée : même remède anti-tressautement que la TabBar. */
    transform: translateZ(0);
  }
  /* ≥ sm : la TabBar disparaît (sidebar rail 72px) → coller en bas, à droite du rail. */
  @media (min-width: 640px) {
    .mini {
      left: calc(72px + 16px);
      right: auto;
      width: 400px;
      bottom: 16px;
    }
  }
  /* ≥ lg (iPad paysage / desktop) : sidebar pleine 280px. */
  @media (min-width: 1024px) {
    .mini {
      left: calc(280px + 20px);
    }
  }

  .body {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
  }
  .thumb {
    width: 44px;
    height: 44px;
    flex: 0 0 44px;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .t {
    font-weight: 700;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .a {
    color: var(--color-muted-fg);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .err {
    color: var(--color-alert);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ctl {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--color-fg);
  }
  .bar {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 4px;
    height: 2.5px;
    border-radius: 99px;
    background: oklch(0.52 0.06 286 / 0.4);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: var(--color-magenta);
    box-shadow: 0 0 8px oklch(0.75 0.23 350 / 0.6);
  }
</style>
