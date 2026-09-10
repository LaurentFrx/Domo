<script lang="ts">
  /**
   * Colonne « Ambiance » du tableau de bord de bureau : de quoi LANCER de la
   * musique et voir ce qui joue — pas de quoi explorer la bibliothèque.
   *
   * Ce panneau ne réimplémente aucune logique : il appelle le store `plex`
   * (mêmes règles, mêmes presets, mêmes stations que /musique) et le lecteur
   * global. Ce qui manque ici — albums, artistes, recherche, gestion des
   * playlists — reste sur /musique, à un clic dans la barre latérale.
   */
  import { onDestroy, onMount } from 'svelte';
  import { acquire } from '$stores/refcount';
  import {
    plex,
    player,
    SMART_PRESETS,
    RADIO_STATIONS,
    type SmartPreset,
    type RadioStation,
    type PlexAlbum,
    type PlexPlaylist
  } from '$stores/plex.svelte';
  import AlbumCover from '$components/music/AlbumCover.svelte';

  let releases: (() => void)[] = [];
  onMount(() => {
    releases = [acquire(plex)];
  });
  onDestroy(() => {
    releases.forEach((r) => r());
    releases = [];
  });

  // Une seule action à la fois, et le nom de ce qu'on attend : sans ça, un clic
  // sur une tuile lente reste sans réponse visible et l'on reclique.
  let busy = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  async function run(id: string, label: string, load: () => Promise<unknown[]>) {
    busy = id;
    actionError = null;
    try {
      const tracks = (await load()) as Parameters<typeof player.play>[0];
      if (tracks.length === 0) {
        actionError = `« ${label} » : rien à jouer pour l'instant.`;
      } else {
        player.shuffle = false;
        player.play(tracks, 0, label);
      }
    } catch (e) {
      actionError = (e as Error).message;
    }
    busy = null;
  }

  const playPreset = (p: SmartPreset) => run(`p:${p.id}`, p.label, () => plex.smartTracks(p.rules));
  const playRadio = (r: RadioStation) => run(`r:${r.id}`, r.label, () => plex.stationTracks(r.id));
  const playAlbum = (a: PlexAlbum) =>
    run(`a:${a.key}`, a.title, async () => (await plex.album(a.key)).tracks);
  const playPlaylist = (pl: PlexPlaylist) =>
    run(`l:${pl.key}`, pl.title, async () => (await plex.playlist(pl.key)).tracks);

  // Les playlists ne sont chargées que par la page /musique : ici on les demande
  // une fois, sans bloquer le reste du panneau si le serveur ne répond pas.
  let playlistsAsked = false;
  $effect(() => {
    if (plex.status === 'ready' && !playlistsAsked) {
      playlistsAsked = true;
      plex.loadPlaylists().catch(() => {
        /* la bibliothèque reste atteignable sur /musique */
      });
    }
  });

  const recents = $derived(plex.recents.slice(0, 4));
  const playlists = $derived(plex.playlists.slice(0, 3));
  const tint = (hue: number) =>
    `background: linear-gradient(140deg, oklch(0.45 0.13 ${hue}), oklch(0.27 0.07 ${(hue + 45) % 360}));`;
</script>

<div class="flex flex-col gap-3">
  <!-- ── Ce qui joue (ou pas) + transport ─────────────────────────────── -->
  <div
    class="now flex items-center gap-3 rounded-[var(--radius-2xl)] border px-3 py-2.5"
    style="background: var(--color-card); border-color: var(--color-border);"
  >
    {#if player.current}
      <button
        class="now-open flex min-w-0 flex-1 items-center gap-3"
        onclick={() => (player.sheetOpen = true)}
        aria-label="Ouvrir le lecteur"
      >
        <span class="now-cover">
          <AlbumCover
            thumb={player.current.thumb}
            title={player.current.album}
            size={120}
            radius={10}
          />
        </span>
        <span class="flex min-w-0 flex-col text-left">
          <span class="now-t truncate">{player.current.title}</span>
          <span class="now-a truncate">{player.current.artist}</span>
        </span>
      </button>
    {:else}
      <span class="flex min-w-0 flex-1 items-center gap-3">
        <span class="now-idle" aria-hidden="true">
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M9 18 V5 L21 3 V16 M9 18 A3 3 0 1 1 3 18 A3 3 0 1 1 9 18 M21 16 A3 3 0 1 1 15 16 A3 3 0 1 1 21 16"
            />
          </svg>
        </span>
        <span class="flex flex-col">
          <span class="now-t">Rien ne joue</span>
          <span class="now-a">Choisissez une ambiance ci-dessous</span>
        </span>
      </span>
    {/if}

    <span class="flex shrink-0 items-center gap-1">
      <button
        class="ctl"
        onclick={() => player.prev()}
        aria-label="Piste précédente"
        disabled={!player.current}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"
          ><path d="M18 5l-9 7 9 7z" /><path d="M6 5h2v14H6z" /></svg
        >
      </button>
      <button
        class="ctl ctl-main"
        onclick={() => player.toggle()}
        aria-label={player.playing ? 'Pause' : 'Lecture'}
        disabled={!player.current}
      >
        {#if player.playing}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
            ><path d="M7 4h4v16H7zM13 4h4v16h-4z" /></svg
          >
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
            ><path d="M7 4l13 8-13 8z" /></svg
          >
        {/if}
      </button>
      <button
        class="ctl"
        onclick={() => player.next()}
        aria-label="Piste suivante"
        disabled={!player.current}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"
          ><path d="M6 5l9 7-9 7z" /><path d="M16 5h2v14h-2z" /></svg
        >
      </button>
    </span>
  </div>

  {#if actionError}
    <p class="err" role="status">{actionError}</p>
  {/if}

  {#if plex.status === 'ready'}
    <!-- ── Ajouts récents : les quatre derniers, en pochettes ─────────── -->
    {#if recents.length > 0}
      <div class="grid grid-cols-4 gap-2">
        {#each recents as a (a.key)}
          <button
            class="cover-btn"
            onclick={() => playAlbum(a)}
            disabled={busy !== null}
            title={a.title}
          >
            <AlbumCover thumb={a.thumb} title={a.title} size={200} radius={10} />
          </button>
        {/each}
      </div>
    {/if}

    <!-- ── Radios : les DJ du serveur ─────────────────────────────────── -->
    <div
      class="flex flex-col gap-2.5 rounded-[var(--radius-2xl)] border px-3 py-3"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <span class="sec">Radios</span>
      <div class="grid grid-cols-2 gap-2">
        {#each RADIO_STATIONS as r (r.id)}
          <button
            class="tile"
            style={tint(r.hue)}
            onclick={() => playRadio(r)}
            disabled={busy !== null}
          >
            <span class="tile-play" aria-hidden="true">
              {#if busy === `r:${r.id}`}
                <span class="wait"></span>
              {:else}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <path
                    d="M5 12.55a11 11 0 0 1 14 0 M8.5 16.05a6 6 0 0 1 7 0 M2 9a15 15 0 0 1 20 0 M12 20h.01"
                  />
                </svg>
              {/if}
            </span>
            <span class="tile-label">{r.label}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- ── Mix intelligents ───────────────────────────────────────────── -->
    <div
      class="flex flex-col gap-2.5 rounded-[var(--radius-2xl)] border px-3 py-3"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <span class="sec">Mix intelligents</span>
      <div class="grid grid-cols-2 gap-2">
        {#each SMART_PRESETS as p (p.id)}
          <button
            class="tile"
            style={tint(p.hue)}
            onclick={() => playPreset(p)}
            disabled={busy !== null}
          >
            <span class="tile-play" aria-hidden="true">
              {#if busy === `p:${p.id}`}
                <span class="wait"></span>
              {:else}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"
                  ><path d="M7 4l13 8-13 8z" /></svg
                >
              {/if}
            </span>
            <span class="tile-label">{p.label}</span>
            <span class="tile-desc">{p.desc}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- ── Playlists ──────────────────────────────────────────────────── -->
    {#if playlists.length > 0}
      <div
        class="flex flex-col gap-1.5 rounded-[var(--radius-2xl)] border px-3 py-3"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <span class="sec">Mes playlists</span>
        {#each playlists as pl (pl.key)}
          <button class="row" onclick={() => playPlaylist(pl)} disabled={busy !== null}>
            <span class="row-ico" aria-hidden="true">
              {#if busy === `l:${pl.key}`}
                <span class="wait wait-dark"></span>
              {:else}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
                  ><path d="M7 4l13 8-13 8z" /></svg
                >
              {/if}
            </span>
            <span class="flex min-w-0 flex-col text-left">
              <span class="row-t truncate">{pl.title}</span>
              <span class="row-s">
                {pl.count === null ? 'Playlist' : `${pl.count} titre${pl.count > 1 ? 's' : ''}`}
              </span>
            </span>
          </button>
        {/each}
        <a class="more" href="/musique">Toute la bibliothèque →</a>
      </div>
    {/if}
  {:else}
    <div
      class="rounded-[var(--radius-2xl)] border px-4 py-5 text-center"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p class="row-s">
        {plex.status === 'loading'
          ? 'Connexion à la bibliothèque…'
          : 'Bibliothèque musicale indisponible'}
      </p>
      <a class="more" href="/musique">Ouvrir Musique</a>
    </div>
  {/if}
</div>

<style>
  .sec {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }
  .now-open {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .now-cover {
    display: block;
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
  }
  .now-idle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--color-primary-muted);
    color: var(--color-primary-active);
  }
  .now-t {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.25;
  }
  .now-a {
    font-size: 11.5px;
    color: var(--color-muted-fg);
    line-height: 1.25;
  }
  .ctl {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--color-muted-fg);
    cursor: pointer;
  }
  .ctl:hover:not(:disabled) {
    color: var(--color-fg);
  }
  .ctl:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ctl-main {
    width: 36px;
    height: 36px;
    background: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .ctl-main:hover:not(:disabled) {
    background: var(--color-primary-hover);
    color: var(--color-primary-fg);
  }
  .cover-btn {
    display: block;
    aspect-ratio: 1;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  /* Mêmes tuiles que /musique (dégradés accents lumineux), en plus compact :
     la colonne fait 434 px, pas 1 200. */
  .tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    min-height: 88px;
    padding: 10px;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    color: oklch(0.97 0.01 286);
    text-align: left;
    box-shadow: var(--shadow-xs);
    font: inherit;
    cursor: pointer;
  }
  .tile:disabled {
    cursor: default;
  }
  .tile-play {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: oklch(0.98 0.01 286 / 0.2);
    margin-bottom: auto;
  }
  .tile-label {
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.2;
  }
  .tile-desc {
    font-size: 10.5px;
    color: oklch(0.97 0.01 286 / 0.75);
    line-height: 1.25;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 0;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .row-ico {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    border-radius: 8px;
    background: var(--color-muted);
    color: var(--color-primary-active);
  }
  .row-t {
    font-size: 12.5px;
    font-weight: 600;
  }
  .row-s {
    font-size: 11px;
    color: var(--color-muted-fg);
  }
  .more {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-primary-active);
    text-decoration: none;
  }
  .err {
    margin: 0;
    padding: 8px 12px;
    border-radius: var(--radius-lg);
    background: var(--color-alert-muted);
    color: var(--color-alert);
    font-size: 12px;
  }
  .wait {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid oklch(0.98 0.01 286 / 0.4);
    border-top-color: oklch(0.98 0.01 286);
    animation: spin 0.8s linear infinite;
  }
  .wait-dark {
    border-color: var(--color-border);
    border-top-color: var(--color-primary-active);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .wait {
      animation: none;
    }
  }
</style>
