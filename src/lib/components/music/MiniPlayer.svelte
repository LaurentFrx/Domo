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
  import { haptic } from '$utils/haptic';
  import AlbumCover from './AlbumCover.svelte';
  import NowPlaying from './NowPlaying.svelte';

  const progress = $derived(
    player.duration > 0 ? Math.min(1, player.currentTime / player.duration) : 0
  );

  // ─── Glisser vers la GAUCHE pour congédier ────────────────────────────────
  // Un morceau fini laisse la file chargée (c'est voulu : on relance de là).
  // Restait qu'aucun geste ne permettait de s'en débarrasser sans ouvrir la
  // feuille plein écran pour y trouver « Arrêter » — le mini semblait collé.
  //
  // Un doigt, horizontal, vers la gauche : le mini suit puis s'en va, et
  // `player.clear()` vide la file (donc `--mini-h` rend sa place aux pages).
  // Vers la droite, résistance seulement : rien ne s'y ferme.
  //
  // Sans conflit avec le Pager, qui exige DEUX doigts ; `data-swipe-ignore` le
  // dit quand même explicitement. `touch-action: pan-y` rend le vertical au
  // navigateur (scroll de la page depuis le mini) — il émet alors
  // `pointercancel`, d'où le handler dédié.
  const CLOSE_PX = 90; // course franche
  const FLICK = 500; // px/s — chiquenaude brève mais nette
  const OUT_MS = 260; // doit suivre la transition CSS de .closing

  let el = $state<HTMLElement | null>(null);
  let dx = $state(0);
  let dragging = $state(false);
  let closing = $state(false);
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastT = 0;
  let vx = 0;
  let pid: number | null = null;
  let locked = false;
  /** Un glissé a eu lieu → le `click` qui suit le relâché n'est pas un tap. */
  let moved = false;

  const opacity = $derived(dragging && dx < 0 ? Math.max(0.25, 1 + dx / 320) : 1);

  function reset() {
    if (pid !== null && el?.hasPointerCapture(pid)) el.releasePointerCapture(pid);
    pid = null;
    locked = false;
    dragging = false;
    dx = 0;
  }

  function onDown(e: PointerEvent) {
    if (closing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pid = e.pointerId;
    startX = lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    vx = 0;
    locked = false;
    moved = false;
  }

  function onMove(e: PointerEvent) {
    if (pid !== e.pointerId || closing) return;
    const ddx = e.clientX - startX;
    const ddy = e.clientY - startY;
    if (!locked) {
      if (Math.abs(ddx) < 10) return; // attendre l'intention
      if (Math.abs(ddx) <= Math.abs(ddy)) {
        pid = null; // geste vertical → laisser filer le scroll
        return;
      }
      locked = true;
      dragging = true;
      el?.setPointerCapture(e.pointerId);
    }
    moved = true;
    const dt = e.timeStamp - lastT;
    if (dt > 0) vx = ((e.clientX - lastX) / dt) * 1000;
    lastX = e.clientX;
    lastT = e.timeStamp;
    dx = ddx < 0 ? ddx : ddx * 0.22; // droite : rubber-band, aucune fermeture
  }

  function onUp(e: PointerEvent) {
    if (pid !== e.pointerId) return;
    const wasDragging = dragging;
    reset();
    if (!wasDragging) return;
    const ddx = e.clientX - startX;
    if (ddx <= -CLOSE_PX || (vx <= -FLICK && ddx < -24)) dismiss();
  }

  function onCancel(e: PointerEvent) {
    if (pid !== e.pointerId) return;
    reset(); // retour élastique à sa place
  }

  function dismiss() {
    haptic('light');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      player.clear();
      return;
    }
    closing = true;
    setTimeout(() => {
      closing = false;
      player.clear();
    }, OUT_MS);
  }

  /**
   * Un glissé se termine par un `click` que le navigateur émet quand même : sans
   * ce filet, congédier le mini ouvrait la feuille plein écran au passage. On le
   * coupe en CAPTURE (avant les boutons, et avant l'haptique déléguée du
   * layout) — le mini ne contient aucun lien, la propagation stoppée ici ne peut
   * donc pas court-circuiter le routeur.
   */
  function onClickCapture(e: MouseEvent) {
    if (!moved) return;
    moved = false;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

{#if player.current}
  <div
    bind:this={el}
    class="mini border"
    class:dragging
    class:closing
    style="background: linear-gradient(var(--color-card), var(--color-card)), var(--color-bg); border-color: var(--color-border);{closing
      ? ''
      : ` transform: translate3d(${dx}px, 0, 0); opacity: ${opacity};`}"
    role="region"
    aria-label="Lecture en cours — glisser vers la gauche pour fermer"
    data-swipe-ignore
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onCancel}
    onclickcapture={onClickCapture}
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
        <!-- L'erreur (ou l'avis de piste sautée) prend la place de l'artiste :
             sans ça, un morceau qui ne démarre pas ne dit RIEN ici, et il
             fallait ouvrir le lecteur pour comprendre pourquoi. -->
        {#if player.lastError || player.skipNotice}
          <span class="err">{player.lastError ?? player.skipNotice}</span>
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
    transform: translate3d(0, 0, 0);
    /* Le vertical reste au navigateur (on scrolle la page depuis le mini) ;
       l'horizontal nous revient pour le geste de congé. */
    touch-action: pan-y;
    transition:
      transform 260ms cubic-bezier(0.2, 0.9, 0.25, 1),
      opacity 200ms ease;
  }
  /* Pendant le glissé, le transform inline suit le doigt : aucune transition,
     sinon il traîne d'un temps de retard. */
  .mini.dragging {
    transition: none;
  }
  /* Sortie : plus de transform inline → cette règle prend la main et anime
     depuis la position atteinte par le doigt. */
  .mini.closing {
    transform: translate3d(calc(-100% - 24px), 0, 0);
    opacity: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .mini {
      transition: none;
    }
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
  /* Desktop À LA SOURIS : la sidebar passe à 280 px (cf. variant `desk` dans
     app.css) — l'iPad, tactile, garde le rail quelle que soit sa largeur. */
  @media (min-width: 1280px) and (pointer: fine) {
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
