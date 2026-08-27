<script lang="ts">
  /**
   * Feuille « Now Playing » plein écran, façon PlexAmp : la POCHETTE FLOUTÉE
   * remplit tout l'écran (voile sombre pour le contraste, masquée si
   * prefers-reduced-transparency), grande pochette nette au centre, indicateur
   * d'écoute animé (gated Animations + reduced-motion), contrôles, file
   * d'attente — et bouton « ⋯ » DISCRET sous le titre : pop-up d'infos complètes
   * du morceau en cours (album, piste, durée, format, taille, fichier) avec,
   * tout en bas, la suppression par APPUI LONG uniquement (jauge 1 s, un tap ne
   * fait rien) ; après suppression la lecture enchaîne sur la suivante.
   *
   * Pendant un drag du curseur de progression, l'affichage suit le doigt
   * (`scrub`) et on ne commet le seek qu'au relâché — sinon timeupdate ferait
   * sauter le curseur sous le doigt (même principe que les sliders WLED).
   */
  import { plex, player, fmtDuration, plexImg } from '$stores/plex.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { wled } from '$stores/wled.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';
  import { WLED_MUSIC_STYLES } from '$lib/wled/music-styles';
  import { acquire } from '$stores/refcount';
  import { haptic } from '$utils/haptic';
  import AlbumCover from './AlbumCover.svelte';
  import BottomSheet from '$components/ui/BottomSheet.svelte';
  import MusicLightPanel from './MusicLightPanel.svelte';
  import FadePanel from './FadePanel.svelte';

  let scrub = $state<number | null>(null);
  const shown = $derived(scrub ?? player.currentTime);
  const remaining = $derived(Math.max(0, player.duration - shown));

  function fmtS(seconds: number): string {
    return fmtDuration(seconds * 1000);
  }

  const upNext = $derived(player.queue.slice(player.index + 1, player.index + 21));
  const backdropUrl = $derived(plexImg(player.current?.thumb, 800));
  const eqOn = $derived(player.playing && preferences.animationsEnabled);

  // ── Lumière qui accompagne la musique ────────────────────────────────────
  // Le réglage vit ICI parce que c'est ici qu'on écoute : régler la lumière
  // d'une soirée ne devrait pas obliger à quitter le lecteur pour la page
  // Pièces. Le panneau lui-même est partagé avec la feuille terrasse.
  let lightOpen = $state(false);

  // ── Enchaînements (fondu réglable + fondu intelligent + nivellement) ─────
  let fadeOpen = $state(false);
  const fadeSummary = $derived.by(() => {
    const fade =
      preferences.musicFadeSeconds <= 0
        ? 'Fondu : désactivé'
        : `Fondu : ${preferences.musicFadeSeconds} s${preferences.musicSmartFades ? ' · intelligent' : ''}`;
    return preferences.musicAutoDj ? `${fade} · DJ` : fade;
  });
  // Le store WLED n'est acquis que par /pieces : sans référence propre, le
  // lecteur afficherait un résumé figé (et le panneau, des lignes vides).
  $effect(() => {
    if (!lightOpen) return;
    const release = acquire(wled);
    return release;
  });

  /** Résumé d'une ligne pour le bouton (« Store : Cascade »). */
  function styleLabel(key: string | null): string {
    if (key === null) return 'aucun';
    return WLED_MUSIC_STYLES.find((s) => s.key === key)?.label ?? key;
  }
  /**
   * Ce que dit le bouton, en un coup d'œil : « Lumière : éteinte » quand le
   * mode est coupé, le style quand une seule ligne suit, sinon « 1 ligne sur
   * 2 » — le détail se lit dans la feuille, pas sur un bouton.
   */
  const lightSummary = $derived.by(() => {
    if (!wledMusic.enabled) return 'Lumière : ne suit pas';
    const segs = wled.segments;
    if (segs.length < 2) return `Lumière : ${styleLabel(wledMusic.style)}`;
    const following = segs.filter((s) => wledMusic.lineStyle(s.id) !== null);
    if (!following.length) return 'Lumière : aucune ligne';
    if (following.length === segs.length) {
      const keys = new Set(following.map((s) => wledMusic.lineStyle(s.id)));
      return keys.size === 1
        ? `Lumière : ${styleLabel(following[0] ? wledMusic.lineStyle(following[0].id) : null)}`
        : 'Lumière : par ligne';
    }
    return `Lumière : ${following.length} ligne${following.length > 1 ? 's' : ''} sur ${segs.length}`;
  });

  // ── Pop-up « infos du morceau » + suppression par APPUI LONG ─────────────
  // La suppression ne doit pas pouvoir partir par erreur : elle vit au fond du
  // pop-up d'infos, derrière un appui MAINTENU (jauge 1 s). Relâcher ou glisser
  // le doigt (>12 px) annule — un tap simple ne fait rien.
  const HOLD_MS = 1000;
  let infoOpen = $state(false);
  let holding = $state(false);
  let deleting = $state(false);
  let delError = $state<string | null>(null);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdStart: { x: number; y: number } | null = null;

  function openInfo() {
    delError = null;
    plPickOpen = false;
    plMsg = null;
    infoOpen = true;
  }

  // ── Ajouter le morceau EN COURS à une playlist (depuis le pop-up ⋯) ──────
  let plPickOpen = $state(false);
  let plBusy = $state(false);
  let plMsg = $state<string | null>(null);
  async function addCurrentTo(plKey: string, plTitle: string) {
    const t = player.current;
    if (!t || plBusy) return;
    plBusy = true;
    plMsg = null;
    try {
      await plex.addToPlaylist(plKey, [t.key]);
      plMsg = `Ajouté à « ${plTitle} ».`;
      plPickOpen = false;
    } catch (e) {
      plMsg = (e as Error).message;
    }
    plBusy = false;
  }
  function closeInfo() {
    cancelHold();
    infoOpen = false;
    delError = null;
  }

  function beginHold(ev: PointerEvent) {
    if (deleting || holding) return;
    holdStart = { x: ev.clientX, y: ev.clientY };
    holding = true;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holding = false;
      void deleteCurrent();
    }, HOLD_MS);
  }
  function moveHold(ev: PointerEvent) {
    if (!holding || !holdStart) return;
    if (Math.hypot(ev.clientX - holdStart.x, ev.clientY - holdStart.y) > 12) cancelHold();
  }
  function cancelHold() {
    holding = false;
    holdStart = null;
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  async function deleteCurrent() {
    const t = player.current;
    if (!t || deleting) return;
    deleting = true;
    delError = null;
    try {
      await plex.deleteItem(t.key);
      haptic('success');
      infoOpen = false;
      player.removeAt(player.index);
    } catch (e) {
      delError = (e as Error).message;
    }
    deleting = false;
  }

  // ── Formatage des infos fichier ──────────────────────────────────────────
  function fmtSize(bytes: number | null): string | null {
    if (!bytes || bytes <= 0) return null;
    return `${(bytes / 1048576).toFixed(1).replace('.', ',')} Mo`;
  }
  function fmtBitrate(t: {
    bitrate: number | null;
    size: number | null;
    duration: number | null;
  }): string | null {
    // Débit annoncé par Plex, sinon CALCULÉ depuis taille/durée pour qu'il soit
    // toujours affiché (octets × 8 / ms = kbit/s exactement).
    const kbps = t.bitrate ?? (t.size && t.duration ? Math.round((t.size * 8) / t.duration) : null);
    return kbps ? `${kbps} kbit/s` : null;
  }
  function fileName(path: string | null): string | null {
    if (!path) return null;
    return path.split('/').pop() ?? null;
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
        <!-- Discret : ouvre le pop-up d'infos (où vit la suppression, appui long) -->
        <button class="info-btn" onclick={openInfo} aria-label="Infos sur le morceau">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle
              cx="19"
              cy="12"
              r="1.9"
            />
          </svg>
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

      <!-- Destination de lecture : sélecteur natif AirPlay (iOS/macOS) ou
           Remote Playback ; absent si le navigateur ne propose ni l'un ni l'autre. -->
      {#if player.outputPicker}
        <button
          class="output"
          class:on={player.wirelessOutput}
          onclick={() => player.pickOutput()}
          aria-label="Choisir la destination de lecture"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1" />
            <path d="m12 15 5 6H7z" />
          </svg>
          {player.outputArmed
            ? 'Toucher encore pour choisir l’enceinte'
            : player.wirelessOutput
              ? 'Lecture sur un autre appareil'
              : 'Sortie audio'}
        </button>
      {/if}

      <!-- Effets lumineux du morceau : même rangée que la sortie audio — ce
           sont les deux réglages « où sort la musique » d'une écoute. -->
      <button
        class="output"
        class:on={wledMusic.enabled}
        onclick={() => {
          haptic('light');
          lightOpen = true;
        }}
        aria-haspopup="dialog"
        aria-label="Régler les effets lumineux de la terrasse"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 1 4 12.8c-.6.5-1 1.2-1 2v1H9v-1c0-.8-.4-1.5-1-2A7 7 0 0 1 12 2z" />
        </svg>
        {lightSummary}
      </button>

      <!-- Enchaînements : fondu réglable + fondu intelligent (analyse Plex). -->
      <button
        class="output"
        class:on={preferences.musicFadeSeconds > 0 || preferences.musicAutoDj}
        onclick={() => {
          haptic('light');
          fadeOpen = true;
        }}
        aria-haspopup="dialog"
        aria-label="Régler les enchaînements entre morceaux"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M2 18c5 0 7-12 12-12h8" />
          <path d="M2 6h8c5 0 7 12 12 12" opacity="0.55" />
        </svg>
        {fadeSummary}
      </button>

      {#if player.lastError || player.skipNotice}
        <p class="error">{player.lastError ?? player.skipNotice}</p>
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

    <!-- Pop-up « infos du morceau » ; la suppression est tout en bas, par APPUI LONG -->
    {#if infoOpen}
      <div class="modal" role="dialog" aria-modal="true" aria-label="Infos sur le morceau">
        <button class="modal-backdrop" onclick={closeInfo} aria-label="Fermer" tabindex="-1"
        ></button>
        <div
          class="modal-card info-card"
          style="background: linear-gradient(var(--color-card), var(--color-card)), var(--color-bg); border-color: var(--color-border);"
        >
          <div class="info-head">
            <span class="info-thumb">
              <AlbumCover
                thumb={player.current.thumb}
                title={player.current.album}
                size={160}
                radius={14}
              />
            </span>
            <div class="min-w-0">
              <p class="modal-title">{player.current.title}</p>
              <p class="info-sub">{player.current.artist}</p>
            </div>
          </div>

          <dl class="info-rows">
            {#if player.current.album}
              <div>
                <dt>Album</dt>
                <dd>{player.current.album}</dd>
              </div>
            {/if}
            {#if player.current.index}
              <div>
                <dt>Piste</dt>
                <dd>
                  {player.current.disc && player.current.disc > 1
                    ? `CD ${player.current.disc} · `
                    : ''}n° {player.current.index}
                </dd>
              </div>
            {/if}
            <div>
              <dt>Durée</dt>
              <dd>{fmtDuration(player.current.duration)}</dd>
            </div>
            {#if player.current.codec}
              <div>
                <dt>Format</dt>
                <dd>{player.current.codec.toUpperCase()}</dd>
              </div>
            {/if}
            {#if fmtBitrate(player.current)}
              <div>
                <dt>Débit</dt>
                <dd>{fmtBitrate(player.current)}</dd>
              </div>
            {/if}
            {#if fmtSize(player.current.size)}
              <div>
                <dt>Taille</dt>
                <dd>{fmtSize(player.current.size)}</dd>
              </div>
            {/if}
            {#if fileName(player.current.file)}
              <div>
                <dt>Fichier</dt>
                <dd class="file">{fileName(player.current.file)}</dd>
              </div>
            {/if}
          </dl>

          <div class="pl-add">
            <button
              class="pl-toggle"
              onclick={() => (plPickOpen = !plPickOpen)}
              aria-expanded={plPickOpen}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"><path d="M4 6h12M4 11h12M4 16h7M17 12v8M13 16h8" /></svg
              >
              Ajouter à une playlist
            </button>
            {#if plPickOpen}
              <div class="pl-list">
                {#each plex.playlists.filter((p) => !p.smart) as pl (pl.key)}
                  <button
                    class="pl-row"
                    onclick={() => addCurrentTo(pl.key, pl.title)}
                    disabled={plBusy}
                  >
                    {pl.title}
                    <span class="pl-count">{pl.count ?? 0}</span>
                  </button>
                {:else}
                  <p class="pl-none">
                    Aucune playlist classique — en créer une depuis l'onglet Playlists.
                  </p>
                {/each}
              </div>
            {/if}
            {#if plMsg}<p class="pl-msg">{plMsg}</p>{/if}
          </div>

          {#if delError}<p class="modal-error">{delError}</p>{/if}

          <!-- Appui LONG uniquement : un tap ne fait rien, relâcher/glisser annule -->
          <button
            class="hold-del"
            class:holding
            disabled={deleting}
            onpointerdown={beginHold}
            onpointermove={moveHold}
            onpointerup={cancelHold}
            onpointercancel={cancelHold}
            onpointerleave={cancelHold}
            oncontextmenu={(e) => e.preventDefault()}
            data-no-haptic
          >
            <span class="hold-fill" aria-hidden="true"></span>
            <span class="hold-label">
              {#if deleting}
                Suppression…
              {:else if holding}
                Maintenir…
              {:else}
                Maintenir pour supprimer le fichier
              {/if}
            </span>
          </button>
          <p class="hold-hint">Appui long (1 s) — définitif, le fichier est effacé du disque.</p>

          <button class="modal-btn close" onclick={closeInfo} disabled={deleting}>Fermer</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<!-- Feuille des effets lumineux. HORS du `{#if player.current}` : elle porte
     le verre Yeldra et son propre overlay (z-100), au-dessus du lecteur
     (z-80) ; l'imbriquer dans la feuille sombre du lecteur la teindrait. -->
<BottomSheet open={lightOpen} title="Lumière de la terrasse" onClose={() => (lightOpen = false)}>
  <MusicLightPanel compact />
</BottomSheet>

<!-- Feuille des enchaînements — même logique de montage que la lumière. -->
<BottomSheet open={fadeOpen} title="Enchaînements" onClose={() => (fadeOpen = false)}>
  <FadePanel />
</BottomSheet>

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

  /* Déclencheur DISCRET du pop-up d'infos : cible 44px, visuel minimal. */
  .info-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 32px;
    margin-top: 8px;
    background: none;
    border: none;
    border-radius: 999px;
    color: oklch(0.96 0.013 286 / 0.55);
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

  .output {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 14px auto 0;
    background: none;
    border: 1px solid oklch(0.96 0.013 286 / 0.25);
    color: oklch(0.96 0.013 286 / 0.75);
    border-radius: var(--radius-pill, 999px);
    padding: 8px 16px;
    font-weight: 600;
    font-size: 13px;
  }
  .output.on {
    color: var(--color-magenta);
    border-color: oklch(0.75 0.23 350 / 0.5);
    background: oklch(0.75 0.23 350 / 0.1);
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
  .modal-error {
    color: var(--color-alert);
    font-size: 13px;
    margin: 0 0 12px;
  }
  .modal-backdrop {
    position: absolute;
    inset: 0;
    background: none;
    border: none;
    padding: 0;
  }
  .modal-btn {
    border-radius: 16px;
    padding: 13px 0;
    font-weight: 700;
    font-size: 15px;
    border: 1px solid var(--color-border);
    background: none;
    color: var(--color-fg);
  }
  .modal-btn.close {
    width: 100%;
    margin-top: 12px;
  }

  /* ── Pop-up infos morceau ─────────────────────────────────────────────── */
  .info-card {
    position: relative;
    text-align: left;
    /* Fond OPAQUE (empilement `--color-card` sur `--color-bg`, comme le
       MiniPlayer) : la pochette plein écran du lecteur passait au travers et
       noyait les valeurs (débit, taille, nom de fichier). Ce fond composé sort
       du sélecteur centralisé d'app.css → l'ombre du verre est reposée ici. */
    box-shadow: var(--shadow-md);
  }
  .info-head {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 14px;
  }
  .info-thumb {
    width: 56px;
    height: 56px;
    flex: 0 0 56px;
  }
  .info-sub {
    color: var(--color-muted-fg);
    font-size: 13.5px;
    margin: 2px 0 0;
  }
  .info-rows {
    margin: 0;
    display: grid;
    gap: 7px;
  }
  .info-rows > div {
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .info-rows dt {
    flex: 0 0 64px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }
  .info-rows dd {
    margin: 0;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
  }
  .info-rows dd.file {
    font-size: 12px;
    font-weight: 500;
    color: var(--color-muted-fg);
    word-break: break-all;
  }

  /* ── Ajouter à une playlist (depuis le pop-up ⋯) ──────────────────────── */
  .pl-add {
    margin-top: 14px;
  }
  .pl-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    border-radius: 14px;
    padding: 11px 0;
    border: 1px solid var(--color-border);
    background: none;
    color: var(--color-fg);
    font-weight: 600;
    font-size: 13.5px;
  }
  .pl-list {
    margin-top: 8px;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    max-height: 32vh;
    overflow-y: auto;
  }
  .pl-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 11px 14px;
    background: none;
    border: none;
    color: var(--color-fg);
    font: inherit;
    font-weight: 600;
    font-size: 14px;
    text-align: left;
  }
  .pl-row + .pl-row {
    border-top: 1px solid oklch(0.52 0.06 286 / 0.25);
  }
  .pl-count {
    color: var(--color-muted-fg);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .pl-none {
    color: var(--color-muted-fg);
    font-size: 12.5px;
    padding: 10px 14px;
    margin: 0;
  }
  .pl-msg {
    color: var(--color-success);
    font-size: 12.5px;
    margin: 8px 2px 0;
  }

  /* ── Suppression par appui long : jauge qui se remplit en 1 s ─────────── */
  .hold-del {
    position: relative;
    overflow: hidden;
    width: 100%;
    margin-top: 16px;
    border-radius: 16px;
    padding: 13px 0;
    border: 1px solid oklch(0.704 0.17 22.2 / 0.4);
    background: oklch(0.704 0.17 22.2 / 0.08);
    color: oklch(0.82 0.13 22);
    font-weight: 700;
    font-size: 14px;
    /* Un appui long ne doit pas déclencher scroll ni sélection. */
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .hold-fill {
    position: absolute;
    inset: 0;
    width: 0;
    background: var(--color-alert);
    transition: none;
  }
  .hold-del.holding .hold-fill {
    width: 100%;
    /* Jauge FONCTIONNELLE (feedback de l'appui long), pas décorative : on la
       garde même en reduced-motion. Durée = HOLD_MS côté script. */
    transition: width 1000ms linear;
  }
  .hold-del.holding {
    color: oklch(0.98 0.01 27);
  }
  .hold-label {
    position: relative;
  }
  .hold-hint {
    color: var(--color-muted-fg);
    font-size: 11.5px;
    text-align: center;
    margin: 8px 0 0;
  }
</style>
