<script lang="ts">
  /**
   * Page Musique — « PlexAmp maison » : bibliothèque Plex (RPi4) + lecteur.
   *
   * États : appairage plex.tv/link (premier lancement), hors-ligne, prêt.
   * Navigation INTERNE en $state (home / artiste / album) : la page est rendue
   * par le pager hors routeur, donc pas de sous-routes. Le mode « Gérer »
   * (ajout de fichiers, suppression d'albums/pistes) est un état de page,
   * volontairement séparé de l'écoute (règle : UI simple pour la famille,
   * suppression toujours derrière une confirmation explicite).
   */
  import { onDestroy, onMount } from 'svelte';
  import { acquire } from '$stores/refcount';
  import {
    plex,
    player,
    fmtDuration,
    type PlexAlbum,
    type PlexArtist,
    type PlexTrack,
    type PlexSearchResults
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

  // ── Navigation interne ──────────────────────────────────────────────────
  type View =
    | { kind: 'home' }
    | { kind: 'artist'; artist: PlexArtist }
    | { kind: 'album'; key: string };
  let view = $state<View>({ kind: 'home' });
  let tab = $state<'albums' | 'artistes'>('albums');
  let manage = $state(false);

  // ── Recherche (debounce 300 ms) ─────────────────────────────────────────
  let query = $state('');
  let results = $state<PlexSearchResults | null>(null);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function onQueryInput() {
    if (searchTimer) clearTimeout(searchTimer);
    const q = query.trim();
    if (q.length < 2) {
      results = null;
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        results = await plex.search(q);
      } catch {
        results = null;
      }
    }, 300);
  }
  function clearSearch() {
    query = '';
    results = null;
  }

  // ── Détail album / artiste ──────────────────────────────────────────────
  let albumDetail = $state<{ album: PlexAlbum; tracks: PlexTrack[] } | null>(null);
  let albumLoading = $state(false);
  async function openAlbum(key: string) {
    view = { kind: 'album', key };
    albumLoading = true;
    albumDetail = null;
    actionError = null;
    try {
      albumDetail = await plex.album(key);
    } catch (e) {
      actionError = (e as Error).message;
    }
    albumLoading = false;
  }

  let artistAlbums = $state<PlexAlbum[]>([]);
  let artistLoading = $state(false);
  async function openArtist(artist: PlexArtist) {
    view = { kind: 'artist', artist };
    artistLoading = true;
    artistAlbums = [];
    actionError = null;
    try {
      artistAlbums = await plex.artistAlbums(artist.key);
    } catch (e) {
      actionError = (e as Error).message;
    }
    artistLoading = false;
  }

  function goHome() {
    view = { kind: 'home' };
  }

  // ── Lecture ─────────────────────────────────────────────────────────────
  function ctxOf(album: PlexAlbum): string {
    return `${album.title} — ${album.artist}`;
  }
  function playOrdered() {
    if (!albumDetail) return;
    player.shuffle = false;
    player.play(albumDetail.tracks, 0, ctxOf(albumDetail.album));
  }
  function playShuffled() {
    if (!albumDetail) return;
    player.shuffle = true;
    player.play(
      albumDetail.tracks,
      Math.floor(Math.random() * albumDetail.tracks.length),
      ctxOf(albumDetail.album)
    );
  }
  function playTrackRow(i: number) {
    if (!albumDetail) return;
    player.play(albumDetail.tracks, i, ctxOf(albumDetail.album));
  }
  /** Depuis la recherche : lance la piste seule (l'album est à un tap si besoin). */
  function playSearchTrack(t: PlexTrack) {
    player.play([t], 0, t.album || null);
  }

  // ── Gestion : upload, scan, suppression ─────────────────────────────────
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploadMsg = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let scanBusy = $state(false);

  async function onFilesChosen(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) return;
    uploadMsg = null;
    actionError = null;
    try {
      const saved = await plex.upload(files);
      uploadMsg =
        saved.length > 1
          ? `${saved.length} fichiers envoyés — Plex les analyse, ils arrivent dans « Ajouts récents ».`
          : `« ${saved[0]} » envoyé — Plex l'analyse, il arrive dans « Ajouts récents ».`;
    } catch (e) {
      actionError = (e as Error).message;
    }
  }

  async function doScan() {
    scanBusy = true;
    actionError = null;
    try {
      await plex.scan();
      uploadMsg = 'Analyse de la bibliothèque lancée.';
    } catch (e) {
      actionError = (e as Error).message;
    }
    scanBusy = false;
  }

  let confirmDelete = $state<{ key: string; title: string; detail: string } | null>(null);
  let deleting = $state(false);
  function askDeleteAlbum(a: PlexAlbum) {
    confirmDelete = {
      key: a.key,
      title: `Supprimer « ${a.title} » ?`,
      detail: `L'album de ${a.artist || 'cet artiste'}${a.tracks ? ` (${a.tracks} titres)` : ''} sera effacé du disque de musique. Cette action est définitive.`
    };
  }
  function askDeleteTrack(t: PlexTrack) {
    confirmDelete = {
      key: t.key,
      title: `Supprimer « ${t.title} » ?`,
      detail: `Le morceau sera effacé du disque de musique. Cette action est définitive.`
    };
  }
  async function doDelete() {
    if (!confirmDelete) return;
    deleting = true;
    actionError = null;
    const deletedKey = confirmDelete.key;
    try {
      await plex.deleteItem(deletedKey);
      confirmDelete = null;
      if (view.kind === 'album') {
        if (albumDetail?.album.key === deletedKey) goHome();
        else if (albumDetail) albumDetail = await plex.album(albumDetail.album.key);
      }
    } catch (e) {
      actionError = (e as Error).message;
    }
    deleting = false;
  }
</script>

<div class="flex flex-col gap-5 py-4" style="padding-bottom: {player.current ? '86px' : '16px'};">
  <!-- ─── En-tête ─────────────────────────────────────────────────────── -->
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold tracking-tight">
      {#if view.kind === 'home'}Musique{:else}
        <button class="back" onclick={goHome} aria-label="Retour à la musique">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"><path d="m14 6-6 6 6 6" /></svg
          >
          Musique
        </button>
      {/if}
    </h1>
    {#if plex.status === 'ready'}
      {#if manage}
        <button class="pill pill-accent" onclick={() => (manage = false)}>Terminé</button>
      {:else}
        <button class="pill" onclick={() => (manage = true)}>Gérer</button>
      {/if}
    {/if}
  </header>

  {#if plex.status === 'idle' || plex.status === 'loading'}
    <div
      class="rounded-[var(--radius-2xl)] border p-6 text-center"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p style="color: var(--color-muted-fg);">Connexion au serveur de musique…</p>
    </div>

    <!-- ─── Non configuré ───────────────────────────────────────────────── -->
  {:else if plex.status === 'unconfigured'}
    <div
      class="rounded-[var(--radius-2xl)] border p-6"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p class="font-semibold">Serveur Plex non configuré</p>
      <p class="mt-2 text-sm" style="color: var(--color-muted-fg);">
        Il manque <code>PLEX_URL</code> dans la configuration du serveur Domo.
      </p>
    </div>

    <!-- ─── Appairage plex.tv/link ──────────────────────────────────────── -->
  {:else if plex.status === 'unlinked'}
    <div
      class="rounded-[var(--radius-3xl,28px)] border p-7 text-center"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <div class="badge" aria-hidden="true">
        <svg
          width="30"
          height="30"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M9 18 V5 L21 3 V16" /><circle cx="6" cy="18" r="3" /><circle
            cx="18"
            cy="16"
            r="3"
          /></svg
        >
      </div>
      <p class="text-lg font-extrabold">Relier Domo à Plex</p>
      <p class="mt-2 text-sm" style="color: var(--color-muted-fg);">
        Sur un autre appareil, ouvrir <b style="color: var(--color-fg);">plex.tv/link</b> et saisir ce
        code :
      </p>

      {#if plex.pin}
        <div class="code" role="status" aria-label="Code d'appairage {plex.pin.code}">
          {#each plex.pin.code.split('') as ch, i (i)}<span>{ch}</span>{/each}
        </div>
        <div class="wait">
          <span class="dot" aria-hidden="true"></span> En attente de l'appairage…
        </div>
        <button class="pill mt-4" onclick={() => plex.renewPin()}>Nouveau code</button>
      {:else}
        <p class="mt-4 text-sm" style="color: var(--color-muted-fg);">Création du code…</p>
        {#if plex.lastError}
          <p class="mt-2 text-sm" style="color: var(--color-alert);">{plex.lastError}</p>
          <button class="pill mt-3" onclick={() => plex.startLink()}>Réessayer</button>
        {/if}
      {/if}
    </div>

    <!-- ─── Hors ligne / erreur ─────────────────────────────────────────── -->
  {:else if plex.status === 'offline' || plex.status === 'error'}
    <div
      class="rounded-[var(--radius-2xl)] border p-6"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p class="font-semibold" style="color: var(--color-alert);">Serveur de musique injoignable</p>
      <p class="mt-2 text-sm" style="color: var(--color-muted-fg);">
        {plex.lastError ?? 'Le serveur Plex du salon ne répond pas.'}
      </p>
      <button class="pill mt-4" onclick={() => plex.refresh()}>Réessayer</button>
    </div>

    <!-- ─── Prêt ────────────────────────────────────────────────────────── -->
  {:else if view.kind === 'home'}
    {#if manage}
      <!-- Mode Gérer : ajout de fichiers + suppression -->
      <div
        class="rounded-[var(--radius-2xl)] border p-6 text-center"
        style="background: var(--color-card); border-color: var(--color-border); border-style: dashed;"
      >
        <div class="badge badge-cyan" aria-hidden="true">
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><path d="M12 16V4m0 0 5 5m-5-5-5 5" /><path d="M4 20h16" /></svg
          >
        </div>
        <p class="font-bold">Ajouter de la musique</p>
        <p class="mt-1 text-sm" style="color: var(--color-muted-fg);">
          Les fichiers (mp3, m4a, flac…) sont envoyés dans la bibliothèque Plex, puis analysés
          automatiquement.
        </p>
        <input
          bind:this={fileInput}
          type="file"
          accept=".mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.wav,.aif,.aiff,audio/*"
          multiple
          class="hidden"
          onchange={onFilesChosen}
        />
        {#if plex.uploadProgress !== null}
          <div
            class="upbar"
            role="progressbar"
            aria-valuenow={Math.round(plex.uploadProgress * 100)}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <i style="width: {plex.uploadProgress * 100}%"></i>
          </div>
          <p class="mt-2 text-sm" style="color: var(--color-muted-fg);">
            Envoi… {Math.round(plex.uploadProgress * 100)} %
          </p>
        {:else}
          <button class="btn-cyan mt-4" onclick={() => fileInput?.click()}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg
            >
            Choisir des fichiers
          </button>
        {/if}
        {#if uploadMsg}<p class="mt-3 text-sm" style="color: var(--color-success);">
            {uploadMsg}
          </p>{/if}
      </div>

      <div class="flex items-center justify-between px-1">
        <p class="section-label">Appuyer sur Supprimer pour retirer un album</p>
        <button class="pill" onclick={doScan} disabled={scanBusy}
          >{scanBusy ? 'Analyse…' : 'Analyser'}</button
        >
      </div>
      <div
        class="rounded-[var(--radius-2xl)] border"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        {#each plex.albums as a (a.key)}
          <div class="row">
            <button class="row-body" onclick={() => openAlbum(a.key)}>
              <span class="row-thumb"
                ><AlbumCover thumb={a.thumb} title={a.title} size={96} radius={12} /></span
              >
              <span class="row-meta">
                <span class="row-t">{a.title}</span>
                <span class="row-a">{a.artist}{a.tracks ? ` · ${a.tracks} titres` : ''}</span>
              </span>
            </button>
            <button class="del" onclick={() => askDeleteAlbum(a)}>Supprimer</button>
          </div>
        {/each}
        {#if plex.albums.length < plex.albumsTotal}
          <button class="more" onclick={() => plex.loadMoreAlbums()}
            >Afficher plus ({plex.albums.length}/{plex.albumsTotal})</button
          >
        {/if}
      </div>
    {:else}
      <!-- Recherche -->
      <div
        class="search rounded-[var(--radius-2xl)] border"
        style="background: var(--color-card); border-color: var(--color-border);"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg
        >
        <input
          type="search"
          placeholder="Titre, album, artiste…"
          bind:value={query}
          oninput={onQueryInput}
          aria-label="Rechercher dans la musique"
        />
        {#if query}
          <button class="clear" onclick={clearSearch} aria-label="Effacer la recherche">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg
            >
          </button>
        {/if}
      </div>

      {#if results && query.trim().length >= 2}
        <!-- Résultats de recherche -->
        {#if results.tracks.length > 0}
          <p class="section-label">Morceaux</p>
          <div
            class="rounded-[var(--radius-2xl)] border"
            style="background: var(--color-card); border-color: var(--color-border);"
          >
            {#each results.tracks as t (t.key)}
              <button class="row row-btn" onclick={() => playSearchTrack(t)}>
                <span class="row-thumb"
                  ><AlbumCover thumb={t.thumb} title={t.album} size={96} radius={12} /></span
                >
                <span class="row-meta">
                  <span class="row-t">{t.title}</span>
                  <span class="row-a">{t.artist}{t.album ? ` · ${t.album}` : ''}</span>
                </span>
                <span class="row-dur">{fmtDuration(t.duration)}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if results.albums.length > 0}
          <p class="section-label">Albums</p>
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {#each results.albums as a (a.key)}
              <button class="album-tile" onclick={() => openAlbum(a.key)}>
                <AlbumCover thumb={a.thumb} title={a.title} size={300} />
                <span class="album-name">{a.title}</span>
                <span class="album-artist">{a.artist}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if results.artists.length > 0}
          <p class="section-label">Artistes</p>
          <div
            class="rounded-[var(--radius-2xl)] border"
            style="background: var(--color-card); border-color: var(--color-border);"
          >
            {#each results.artists as ar (ar.key)}
              <button class="row row-btn" onclick={() => openArtist(ar)}>
                <span class="row-thumb round"
                  ><AlbumCover thumb={ar.thumb} title={ar.title} size={96} radius={99} /></span
                >
                <span class="row-meta"><span class="row-t">{ar.title}</span></span>
              </button>
            {/each}
          </div>
        {/if}
        {#if results.tracks.length === 0 && results.albums.length === 0 && results.artists.length === 0}
          <p class="text-center text-sm" style="color: var(--color-muted-fg);">
            Aucun résultat pour « {query.trim()} ».
          </p>
        {/if}
      {:else}
        <!-- Accueil bibliothèque -->
        {#if plex.recents.length > 0}
          <p class="section-label">Ajouts récents</p>
          <div class="recents">
            {#each plex.recents as a (a.key)}
              <button class="album-tile mini" onclick={() => openAlbum(a.key)}>
                <AlbumCover thumb={a.thumb} title={a.title} size={240} />
                <span class="album-name">{a.title}</span>
                <span class="album-artist">{a.artist}</span>
              </button>
            {/each}
          </div>
        {/if}

        <div class="tabs" role="tablist" aria-label="Bibliothèque">
          <button
            role="tab"
            aria-selected={tab === 'albums'}
            class:on={tab === 'albums'}
            onclick={() => (tab = 'albums')}
          >
            Albums{plex.albumsTotal ? ` · ${plex.albumsTotal}` : ''}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'artistes'}
            class:on={tab === 'artistes'}
            onclick={() => (tab = 'artistes')}
          >
            Artistes{plex.artists.length ? ` · ${plex.artists.length}` : ''}
          </button>
        </div>

        {#if tab === 'albums'}
          {#if plex.albums.length === 0}
            <p class="text-center text-sm" style="color: var(--color-muted-fg);">
              Bibliothèque vide — utiliser « Gérer » pour ajouter de la musique.
            </p>
          {:else}
            <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {#each plex.albums as a (a.key)}
                <button class="album-tile" onclick={() => openAlbum(a.key)}>
                  <AlbumCover thumb={a.thumb} title={a.title} size={300} />
                  <span class="album-name">{a.title}</span>
                  <span class="album-artist">{a.artist}</span>
                </button>
              {/each}
            </div>
            {#if plex.albums.length < plex.albumsTotal}
              <button class="more" onclick={() => plex.loadMoreAlbums()}
                >Afficher plus ({plex.albums.length}/{plex.albumsTotal})</button
              >
            {/if}
          {/if}
        {:else}
          <div
            class="rounded-[var(--radius-2xl)] border"
            style="background: var(--color-card); border-color: var(--color-border);"
          >
            {#each plex.artists as ar (ar.key)}
              <button class="row row-btn" onclick={() => openArtist(ar)}>
                <span class="row-thumb round"
                  ><AlbumCover thumb={ar.thumb} title={ar.title} size={96} radius={99} /></span
                >
                <span class="row-meta">
                  <span class="row-t">{ar.title}</span>
                  {#if ar.albums}<span class="row-a"
                      >{ar.albums} album{ar.albums > 1 ? 's' : ''}</span
                    >{/if}
                </span>
                <svg
                  class="chev"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg
                >
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}

    <!-- ─── Vue artiste ─────────────────────────────────────────────────── -->
  {:else if view.kind === 'artist'}
    <h2 class="px-1 text-xl font-bold tracking-tight">{view.artist.title}</h2>
    {#if artistLoading}
      <p class="text-center text-sm" style="color: var(--color-muted-fg);">Chargement…</p>
    {:else}
      <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {#each artistAlbums as a (a.key)}
          <button class="album-tile" onclick={() => openAlbum(a.key)}>
            <AlbumCover thumb={a.thumb} title={a.title} size={300} />
            <span class="album-name">{a.title}</span>
            <span class="album-artist">{a.year ?? ''}</span>
          </button>
        {/each}
      </div>
    {/if}

    <!-- ─── Vue album ───────────────────────────────────────────────────── -->
  {:else if view.kind === 'album'}
    {#if albumLoading}
      <p class="text-center text-sm" style="color: var(--color-muted-fg);">Chargement…</p>
    {:else if albumDetail}
      <div class="lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
        <div class="flex flex-col gap-4">
          <div
            class="hero rounded-[var(--radius-2xl)] border p-4"
            style="background: var(--color-card); border-color: var(--color-border);"
          >
            <div class="hero-cover">
              <AlbumCover
                thumb={albumDetail.album.thumb}
                title={albumDetail.album.title}
                size={400}
              />
            </div>
            <div class="min-w-0">
              <h2 class="text-lg leading-tight font-extrabold">{albumDetail.album.title}</h2>
              {#if albumDetail.album.artistKey}
                <button
                  class="hero-artist"
                  onclick={() => {
                    const k = albumDetail?.album.artistKey;
                    if (k)
                      openArtist({
                        key: k,
                        title: albumDetail?.album.artist ?? '',
                        thumb: null,
                        albums: null
                      });
                  }}
                >
                  {albumDetail.album.artist}
                </button>
              {:else}
                <p class="hero-artist">{albumDetail.album.artist}</p>
              {/if}
              <p class="mt-1 text-xs" style="color: var(--color-muted-fg);">
                {albumDetail.album.year ? `${albumDetail.album.year} · ` : ''}{albumDetail.tracks
                  .length}
                titres
              </p>
            </div>
          </div>

          <div class="flex gap-3">
            <button class="btn-play" onclick={playOrdered}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
                ><path d="M6 4l14 8-14 8z" /></svg
              >
              Lecture
            </button>
            <button class="btn-shuffle" onclick={playShuffled}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><path
                  d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7M16 21h5v-5M21 21l-6-6M3 3l6 6"
                /></svg
              >
              Aléatoire
            </button>
          </div>
          {#if manage}
            <button
              class="del self-start"
              onclick={() => albumDetail && askDeleteAlbum(albumDetail.album)}
            >
              Supprimer l'album
            </button>
          {/if}
        </div>

        <div
          class="mt-4 rounded-[var(--radius-2xl)] border lg:mt-0"
          style="background: var(--color-card); border-color: var(--color-border);"
        >
          {#each albumDetail.tracks as t, i (t.key)}
            {@const isCurrent = player.current?.key === t.key}
            <div class="row">
              <button class="row-body" onclick={() => playTrackRow(i)}>
                <span class="num" class:playing={isCurrent}>
                  {#if isCurrent}
                    <span class="eq" aria-label="En cours de lecture"><i></i><i></i><i></i></span>
                  {:else}
                    {t.index ?? i + 1}
                  {/if}
                </span>
                <span class="row-meta">
                  <span class="row-t" class:playing={isCurrent}>{t.title}</span>
                  {#if t.artist && t.artist !== albumDetail.album.artist}
                    <span class="row-a">{t.artist}</span>
                  {/if}
                </span>
              </button>
              {#if manage}
                <button
                  class="del compact"
                  onclick={() => askDeleteTrack(t)}
                  aria-label="Supprimer {t.title}"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" /></svg
                  >
                </button>
              {:else}
                <span class="row-dur">{fmtDuration(t.duration)}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  {#if actionError}
    <p
      class="rounded-[var(--radius-2xl)] border p-3 text-sm"
      style="border-color: var(--color-alert); color: var(--color-alert); background: var(--color-alert-muted);"
    >
      {actionError}
    </p>
  {/if}
</div>

<!-- ─── Confirmation de suppression (règle : jamais de suppression sèche) ── -->
{#if confirmDelete}
  <div class="modal" role="dialog" aria-modal="true" aria-label={confirmDelete.title}>
    <div
      class="modal-card rounded-[var(--radius-3xl,28px)] border p-5 text-center"
      style="background: var(--color-card); border-color: var(--color-border);"
    >
      <p class="text-base font-bold">{confirmDelete.title}</p>
      <p class="mt-2 mb-4 text-sm" style="color: var(--color-muted-fg);">{confirmDelete.detail}</p>
      <div class="flex gap-3">
        <button class="modal-btn" onclick={() => (confirmDelete = null)} disabled={deleting}
          >Annuler</button
        >
        <button class="modal-btn danger" onclick={doDelete} disabled={deleting}>
          {deleting ? 'Suppression…' : 'Supprimer'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    color: var(--color-muted-fg);
    font: inherit;
    font-weight: 600;
    padding: 0;
  }

  .pill {
    border: 1px solid var(--color-border);
    background: var(--color-card);
    color: var(--color-muted-fg);
    border-radius: var(--radius-pill, 999px);
    padding: 8px 16px;
    font-weight: 600;
    font-size: 14px;
  }
  .pill-accent {
    background: var(--color-magenta);
    border-color: transparent;
    color: oklch(0.18 0.05 350);
    font-weight: 700;
  }

  .badge {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    margin: 0 auto 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(0.88 0.24 152 / 0.12);
    color: var(--color-glow);
    box-shadow: 0 0 26px -6px oklch(0.88 0.24 152 / 0.5);
  }
  .badge-cyan {
    width: 52px;
    height: 52px;
    background: oklch(0.82 0.15 200 / 0.14);
    color: var(--color-cyan);
    box-shadow: none;
  }

  .code {
    display: flex;
    justify-content: center;
    gap: 10px;
    margin: 18px 0;
  }
  .code span {
    width: 54px;
    height: 66px;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    font-weight: 800;
    background: oklch(0.185 0.04 286 / 0.35);
    border: 1px solid var(--color-border);
    color: var(--color-cyan);
    text-shadow: 0 0 18px oklch(0.82 0.15 200 / 0.5);
  }
  .wait {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--color-muted-fg);
    font-size: 13px;
    font-weight: 600;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-glow);
    box-shadow: 0 0 10px var(--color-glow);
  }

  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 14px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    outline: none;
    color: var(--color-fg);
    font-size: 16px; /* anti-zoom iOS */
    padding: 10px 0;
  }
  .search input::placeholder {
    color: var(--color-muted-fg);
  }
  .search svg {
    color: var(--color-muted-fg);
    flex: 0 0 auto;
  }
  .clear {
    background: none;
    border: none;
    color: var(--color-muted-fg);
    display: flex;
    padding: 6px;
  }

  .section-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
    margin: 4px 4px 0;
  }

  .recents {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    padding: 4px;
    margin: 0 -4px;
    -webkit-overflow-scrolling: touch;
  }

  .album-tile {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    min-width: 0;
  }
  .album-tile.mini {
    flex: 0 0 116px;
  }
  .album-name {
    font-weight: 700;
    font-size: 13.5px;
    margin-top: 7px;
    line-height: 1.25;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .album-artist {
    color: var(--color-muted-fg);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tabs {
    display: flex;
    gap: 8px;
  }
  .tabs button {
    border: 1px solid var(--color-border);
    background: none;
    color: var(--color-muted-fg);
    border-radius: var(--radius-pill, 999px);
    padding: 8px 16px;
    font-weight: 600;
    font-size: 13.5px;
  }
  .tabs button.on {
    background: var(--color-primary-muted);
    border-color: var(--color-primary-active);
    color: var(--color-primary-active);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 12px;
  }
  .row + .row,
  .row + .more,
  .row-btn + .row-btn {
    border-top: 1px solid oklch(0.52 0.06 286 / 0.25);
  }
  .row-btn {
    width: 100%;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .row-body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 10px 0;
  }
  .row-btn {
    padding: 10px 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .row-thumb {
    width: 44px;
    height: 44px;
    flex: 0 0 44px;
  }
  .row-thumb.round :global(img),
  .row-thumb.round :global(div) {
    border-radius: 50%;
  }
  .row-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .row-t {
    font-weight: 600;
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-t.playing {
    color: var(--color-magenta);
  }
  .row-a {
    color: var(--color-muted-fg);
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-dur {
    color: var(--color-muted-fg);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .chev {
    color: var(--color-muted-fg);
  }

  .num {
    width: 22px;
    text-align: right;
    color: var(--color-muted-fg);
    font-variant-numeric: tabular-nums;
    font-size: 14px;
    flex: 0 0 22px;
  }
  .eq {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
  }
  .eq i {
    width: 3px;
    border-radius: 2px;
    background: var(--color-magenta);
    animation: eq 1s ease-in-out infinite;
  }
  .eq i:nth-child(1) {
    height: 6px;
    animation-delay: 0s;
  }
  .eq i:nth-child(2) {
    height: 13px;
    animation-delay: 0.2s;
  }
  .eq i:nth-child(3) {
    height: 9px;
    animation-delay: 0.4s;
  }
  @keyframes eq {
    0%,
    100% {
      transform: scaleY(1);
    }
    50% {
      transform: scaleY(0.45);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .eq i {
      animation: none;
    }
  }

  .more {
    display: block;
    width: 100%;
    background: none;
    border: none;
    border-top: 1px solid oklch(0.52 0.06 286 / 0.25);
    color: var(--color-primary-active);
    font-weight: 600;
    font-size: 14px;
    padding: 12px;
    margin-top: 2px;
  }

  .hero {
    display: flex;
    gap: 16px;
    align-items: center;
  }
  .hero-cover {
    width: 116px;
    flex: 0 0 116px;
  }
  .hero-artist {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-weight: 600;
    font-size: 14.5px;
    color: var(--color-primary-active);
  }

  .btn-play,
  .btn-shuffle {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: var(--radius-pill, 999px);
    padding: 13px 0;
    font-weight: 700;
    font-size: 15px;
  }
  .btn-play {
    background: var(--color-magenta);
    border: none;
    color: oklch(0.18 0.05 350);
    box-shadow: 0 0 22px -4px oklch(0.75 0.23 350 / 0.5);
  }
  .btn-shuffle {
    background: var(--color-card);
    border: 1px solid var(--color-border);
    color: var(--color-fg);
  }

  .btn-cyan {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: var(--color-cyan);
    color: oklch(0.2 0.05 200);
    border: none;
    border-radius: var(--radius-pill, 999px);
    padding: 12px 22px;
    font-weight: 700;
    font-size: 15px;
  }

  .upbar {
    height: 8px;
    border-radius: 99px;
    background: oklch(0.52 0.06 286 / 0.4);
    margin-top: 16px;
    overflow: hidden;
  }
  .upbar i {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: var(--color-cyan);
    box-shadow: 0 0 10px oklch(0.82 0.15 200 / 0.6);
    transition: width 0.2s ease;
  }

  .del {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-alert);
    border: 1px solid oklch(0.704 0.17 22.2 / 0.45);
    background: var(--color-alert-muted);
    border-radius: var(--radius-pill, 999px);
    padding: 8px 14px;
    font-weight: 700;
    font-size: 13px;
    flex: 0 0 auto;
  }
  .del.compact {
    padding: 8px 10px;
  }

  .modal {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: oklch(0.13 0.03 286 / 0.55);
  }
  .modal-card {
    width: 100%;
    max-width: 360px;
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
