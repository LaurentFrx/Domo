<script lang="ts">
  /**
   * Tuile « lampe » de l'éclairage terrasse — surface par défaut sur /pieces.
   *
   * Le panneau de contrôle empilé (barre héros + luminosité + scènes + styles
   * musicaux + accordéon de réglages) coûtait 5 à 7 rangées au milieu d'une
   * page déjà dense. Ici la carte se résume à UN objet : la tuile EST la
   * lumière — son fond se remplit de la couleur réelle du ruban, sur la
   * largeur = la luminosité. Tout le reste vit dans la feuille (WledSheet).
   *
   * Gestes (façon Maison iOS, mais à l'HORIZONTALE — le ruban est horizontal) :
   *   - glissé HORIZONTAL sur la tuile → luminosité, en direct ;
   *   - tap (moins de 6 px de déplacement) → ouvre la feuille de réglages ;
   *   - l'interrupteur et le bouton Réglages restent des cibles à part.
   * `touch-action: pan-y` rend explicitement le défilement vertical de la page
   * au navigateur : la tuile ne crée pas de zone morte au milieu de /pieces.
   * Le Pager, lui, ne navigue qu'à DEUX doigts — aucun conflit ; `data-swipe-ignore`
   * est la ceinture en plus des bretelles.
   *
   * Lueur : quand le mode Musique joue, l'intensité de la lueur suit le niveau
   * sonore serveur (var CSS `--mvol` en rAF, hors réactivité Svelte). Gated
   * `animationsEnabled` + `prefers-reduced-motion`, en pause en arrière-plan.
   */
  import { wled, previewColor } from '$stores/wled.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import { averageRgb, gradientStops, stateLabel, vividTint } from '$lib/wled/preview-model';
  import { haptic } from '$utils/haptic';

  interface Props {
    /** Ouvre la feuille de réglages (tap sur la tuile ou bouton dédié). */
    onopen: () => void;
  }
  let { onopen }: Props = $props();

  // ─── Modèle d'affichage ────────────────────────────────────────────────
  // Une tuile = UN résumé : on peint la ligne la plus longue effectivement
  // allumée (à défaut, la plus longue tout court). Les lignes se détaillent
  // dans la feuille, pas ici.
  const dominant = $derived.by(() => {
    const segs = wled.segments;
    if (!segs.length) return null;
    const pool = segs.filter((s) => s.on);
    return (pool.length ? pool : segs).reduce((a, b) => (b.len > a.len ? b : a));
  });

  const music = $derived({
    enabled: wledMusic.enabled,
    analyzing: wledMusic.analyzing,
    trackKey: wledMusic.trackKey,
    playing: wledMusic.playing
  });

  const model = $derived.by(() => {
    const seg = dominant;
    if (!seg) {
      return {
        lit: false,
        paint: 'transparent',
        glow: '0 0 0',
        label: wled.connected ? 'Aucun segment configuré' : 'Connexion au module LED…'
      };
    }
    const lit = wled.on && seg.on;
    const fxName = wled.effects[seg.fx] ?? 'Solid';
    const palName = wled.palettes[seg.pal] ?? 'Default';
    // Effet/palette multicolore → on peint ses vraies couleurs ; sinon la
    // TEINTE du segment, remontée à pleine luminance (`vividTint`) : ici le
    // niveau est porté par la largeur et la lueur, pas par la couleur.
    const stops = lit ? gradientStops(fxName, palName) : null;
    const tint = vividTint(previewColor(seg.col, seg.white));
    const glow = stops ? vividTint(averageRgb(stops)) : tint;
    const whiteOnly = seg.col[0] === 0 && seg.col[1] === 0 && seg.col[2] === 0 && seg.white > 0;

    // Une ligne éteinte pendant que l'autre éclaire est invisible sur une
    // tuile-résumé : le dire, sinon l'utilisateur croit tout allumé.
    const offLines = wled.on ? wled.segments.filter((s) => !s.on).length : 0;
    const base = stateLabel({ on: lit, fxName, whiteOnly, music });
    const label =
      offLines > 0
        ? `${base} · ${offLines} ligne${offLines > 1 ? 's' : ''} éteinte${offLines > 1 ? 's' : ''}`
        : base;

    return {
      lit,
      paint: stops
        ? `linear-gradient(90deg, ${stops.join(', ')})`
        : `linear-gradient(90deg, rgb(${tint.join(' ')}), rgb(${tint.join(' ')}))`,
      glow: glow.join(' '),
      label
    };
  });

  // Badge d'état SEULEMENT si anormal — « connecté » est l'état attendu.
  const abnormal = $derived(!wled.connected ? 'Hors ligne' : wled.isMock ? 'Démo' : null);

  // ─── Luminosité : niveau affiché (optimiste pendant le glissé) ─────────
  const briPct = $derived(Math.round((wled.bri / 255) * 100));
  let dragging = $state(false);
  let dragPct = $state(0);
  const shownPct = $derived(dragging ? dragPct : briPct);
  /** Largeur du remplissage : 0 quand c'est éteint (la tuile s'éteint vraiment). */
  const fillPct = $derived(model.lit ? shownPct : 0);

  // ─── Glissé horizontal = luminosité ────────────────────────────────────
  const SLOP = 6; // px avant de trancher entre « tap », « scroll » et « glissé »
  const SEND_MS = 90; // cadence max des POST pendant le glissé (le store gèle le resync)
  let surfEl = $state<HTMLDivElement | null>(null);
  let armed = false;
  let startX = 0;
  let startY = 0;
  let lastSent = 0;

  function pctFromX(clientX: number): number {
    const r = surfEl?.getBoundingClientRect();
    if (!r || r.width === 0) return shownPct;
    return Math.max(0, Math.min(100, Math.round(((clientX - r.left) / r.width) * 100)));
  }

  function send(pct: number, force = false): void {
    const now = performance.now();
    if (!force && now - lastSent < SEND_MS) return;
    lastSent = now;
    wled.setBri(Math.round(pct * 2.55));
  }

  function onPointerDown(e: PointerEvent): void {
    // Pas de capture ici : tant qu'on n'a pas tranché, le navigateur doit
    // pouvoir démarrer un défilement vertical de la page.
    armed = true;
    startX = e.clientX;
    startY = e.clientY;
  }

  function onPointerMove(e: PointerEvent): void {
    if (!armed) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      // Geste vertical dominant = défilement de la page : on lâche l'affaire.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SLOP) {
        armed = false;
        return;
      }
      if (Math.abs(dx) <= SLOP) return;
      if (!wled.on) {
        // Éteint : la luminosité n'a pas de sens (comme la ligne grisée de
        // l'ancienne carte). On n'allume JAMAIS sur un glissé involontaire.
        armed = false;
        return;
      }
      dragging = true;
      dragPct = briPct;
      surfEl?.setPointerCapture(e.pointerId);
      haptic('light'); // accroche du slider, comme en natif
    }
    e.preventDefault();
    dragPct = pctFromX(e.clientX);
    send(dragPct);
  }

  function onPointerUp(e: PointerEvent): void {
    if (dragging) {
      const pct = pctFromX(e.clientX);
      surfEl?.releasePointerCapture(e.pointerId);
      dragPct = pct;
      send(pct, true);
      dragging = false;
    } else if (armed) {
      haptic('light');
      onopen();
    }
    armed = false;
  }

  /** Geste ABANDONNÉ (scroll qui prend la main, appel entrant…) : on ne
   *  commande rien de plus et on ne prend surtout pas ça pour un tap. */
  function onPointerCancel(e: PointerEvent): void {
    if (dragging) {
      surfEl?.releasePointerCapture(e.pointerId);
      send(dragPct, true);
      dragging = false;
    }
    armed = false;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!wled.on) return;
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? 5
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -5
          : e.key === 'PageUp'
            ? 20
            : e.key === 'PageDown'
              ? -20
              : 0;
    let next = step ? briPct + step : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : -1;
    if (next < 0) return;
    e.preventDefault();
    next = Math.max(0, Math.min(100, next));
    send(next, true);
  }

  // ─── Lueur qui respire avec la musique (--mvol, rAF) ───────────────────
  let hidden = $state(false);
  $effect(() => {
    if (typeof document === 'undefined') return;
    hidden = document.visibilityState === 'hidden';
    const onVis = () => (hidden = document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });

  const pulsing = $derived(
    model.lit && wledMusic.reactive && wledMusic.playing && preferences.animationsEnabled && !hidden
  );

  let tileEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (!pulsing || !tileEl) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = tileEl;
    let raf = 0;
    let smooth = 0.4;
    const tick = () => {
      let v = wledMusic.liveLevel;
      if (wledMusic.livePeak) v = Math.max(v, 0.95);
      smooth = v > smooth ? v : smooth * 0.88 + v * 0.12; // attaque vive, retombée douce
      el.style.setProperty('--mvol', smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.removeProperty('--mvol');
    };
  });
</script>

<div
  bind:this={tileEl}
  class="tile"
  class:lit={model.lit}
  class:dragging
  style="background: var(--color-card); border-color: var(--color-border); --lvl: {fillPct}%; --lvlf: {fillPct /
    100}; --paint: {model.paint}; --glow: {model.glow};"
>
  <!-- Lueur ambiante : c'est la lumière qui déborde de la tuile. -->
  <div class="tile-glow" aria-hidden="true"></div>
  <!-- Lavage : peinture pleine largeur RÉVÉLÉE jusqu'au niveau (masque) — le
       dégradé reste ancré à la tuile au lieu d'être comprimé par la largeur. -->
  <div class="tile-paint" aria-hidden="true"></div>
  <!-- LE RUBAN : la lecture précise du niveau. Un lavage translucide sur fond
       sombre donne un brun sale, jamais « de la lumière » ; ce trait-là, lui,
       est vif et bloomé — c'est lui qui dit « allumé ». -->
  <div class="tile-bar" aria-hidden="true">
    <div class="tile-bar-fill"></div>
    <div class="tile-bar-tip"></div>
  </div>

  <!-- Surface de geste : glissé = luminosité, tap = feuille. `data-no-haptic`
       car les retours sont déclenchés explicitement (accroche / tap). -->
  <div
    bind:this={surfEl}
    class="tile-surface"
    role="slider"
    tabindex="0"
    aria-label="Luminosité de l'éclairage terrasse"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={shownPct}
    aria-valuetext="{shownPct} %"
    aria-disabled={!wled.on}
    data-no-haptic
    data-swipe-ignore
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    onkeydown={onKeydown}
  ></div>

  <div class="tile-body">
    <span class="tile-icon" aria-hidden="true">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M12 2a7 7 0 0 1 4 12.8c-.6.5-1 1.2-1 2v1H9v-1c0-.8-.4-1.5-1-2A7 7 0 0 1 12 2z" />
      </svg>
    </span>

    <div class="tile-text">
      <span class="tile-title">
        LED Terrasse
        {#if abnormal}
          <span
            class="tile-badge"
            style="color: {wled.connected ? 'var(--color-mandarine)' : 'var(--color-alert)'};"
          >
            {abnormal}
          </span>
        {/if}
      </span>
      <span class="tile-state">{model.label}</span>
      <span class="tile-pct tabular-nums" class:off={!wled.on}>
        {shownPct}<span class="tile-pct-unit"> %</span>
      </span>
    </div>

    <div class="tile-actions">
      <label class="toggle-pill" aria-label="Allumer / éteindre l'éclairage terrasse">
        <input
          type="checkbox"
          checked={wled.on}
          onchange={(e) => {
            haptic('light');
            // L'interrupteur coupe la LUMIÈRE, pas le mode Musique : le serveur
            // suspend le stream tant que le ruban est éteint.
            wled.setOn((e.currentTarget as HTMLInputElement).checked);
          }}
        />
        <span class="toggle-pill-knob"></span>
      </label>

      <button
        type="button"
        class="tile-more"
        aria-label="Réglages de l'éclairage terrasse"
        onclick={onopen}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
          <circle cx="16" cy="7" r="2" />
          <circle cx="10" cy="17" r="2" />
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  .tile {
    position: relative;
    overflow: hidden;
    min-height: 128px;
    border-width: 1px;
    border-style: solid;
    border-radius: var(--radius-2xl);
    /* Repos neutre quand la musique ne pilote pas la lueur. */
    --mvol: 0.5;
  }

  /* ─── Couches lumineuses ─────────────────────────────────────────────── */
  /* Lueur ambiante : elle déborde du niveau, comme une vraie source. */
  .tile-glow {
    position: absolute;
    inset: -40% -10%;
    background: radial-gradient(
      60% 90% at calc(var(--lvl) * 0.85) 50%,
      rgb(var(--glow) / 0.5),
      transparent 70%
    );
    opacity: 0;
    transition:
      opacity var(--duration-normal) var(--ease-default),
      background var(--duration-normal) var(--ease-default);
    pointer-events: none;
  }
  .tile.lit .tile-glow {
    /* Le NIVEAU se lit aussi dans l'intensité (une lampe à 5 % doit être
       faible, pas juste étroite). Sans musique --mvol vaut 0.5 → facteur 1 :
       la lueur ne dépend du son que si la boucle rAF alimente la variable. */
    opacity: calc((0.18 + var(--lvlf) * 0.5) * (0.55 + var(--mvol) * 0.9));
  }

  /* Peinture du ruban, ancrée à la tuile et révélée jusqu'au niveau. */
  .tile-paint {
    position: absolute;
    inset: 0;
    background: var(--paint);
    opacity: 0;
    /* DISSOLUTION, pas bloc : un rectangle net à la coupe se lit « barre de
       progression » (et brun sale sur fond sombre). La lumière s'éteint en
       s'éloignant de sa source ; la lecture exacte du niveau, c'est le ruban. */
    -webkit-mask-image: linear-gradient(
      90deg,
      #000 0,
      rgb(0 0 0 / 0.5) calc(var(--lvl) * 0.55),
      transparent var(--lvl)
    );
    mask-image: linear-gradient(
      90deg,
      #000 0,
      rgb(0 0 0 / 0.5) calc(var(--lvl) * 0.55),
      transparent var(--lvl)
    );
    transition:
      opacity var(--duration-normal) var(--ease-default),
      -webkit-mask-image var(--duration-normal) var(--ease-default),
      mask-image var(--duration-normal) var(--ease-default);
    pointer-events: none;
  }
  .tile.lit .tile-paint {
    /* Discret : il pose l'ambiance, c'est le ruban qui porte la lecture. */
    opacity: calc(0.16 + var(--lvlf) * 0.16);
  }
  /* Sombre : plafond volontairement bas (0.26). Au-delà, un lavage clair à
     100 % passe sous la barre de contraste du texte — lisibilité d'abord, et
     de toute façon c'est le ruban qui porte le signal. */
  :global([data-theme='dark']) .tile.lit .tile-paint {
    opacity: calc(0.12 + var(--lvlf) * 0.14);
  }

  /* ─── Le ruban ────────────────────────────────────────────────────────── */
  .tile-bar {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 12px;
    height: 6px;
    border-radius: 9999px;
    background: var(--color-muted);
    pointer-events: none;
  }
  .tile-bar-fill {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--paint);
    /* Révélé jusqu'au niveau (% = largeur du ruban), dégradé non comprimé. */
    -webkit-mask-image: linear-gradient(
      90deg,
      #000 0,
      #000 calc(var(--lvl) - 3px),
      transparent var(--lvl)
    );
    mask-image: linear-gradient(90deg, #000 0, #000 calc(var(--lvl) - 3px), transparent var(--lvl));
    opacity: 0;
    transition:
      opacity var(--duration-normal) var(--ease-default),
      -webkit-mask-image var(--duration-normal) var(--ease-default),
      mask-image var(--duration-normal) var(--ease-default);
  }
  .tile.lit .tile-bar-fill {
    opacity: 1;
  }
  /* Tête du ruban : le bloom qui fait « lumière » et non « barre de progression ».
     Séparée du fill parce qu'un masque rogne aussi les ombres portées. */
  .tile-bar-tip {
    position: absolute;
    top: 50%;
    left: var(--lvl);
    width: 8px;
    height: 8px;
    margin: -4px 0 0 -6px;
    border-radius: 50%;
    background: rgb(var(--glow));
    box-shadow:
      0 0 10px 2px rgb(var(--glow) / 0.75),
      0 0 26px 6px rgb(var(--glow) / 0.4);
    opacity: 0;
    transition:
      opacity var(--duration-normal) var(--ease-default),
      left var(--duration-normal) var(--ease-default);
  }
  .tile.lit .tile-bar-tip {
    opacity: 1;
  }

  /* Pendant le glissé, tout suit le doigt SANS interpolation (sinon le niveau
     traîne derrière le pouce). */
  .tile.dragging .tile-glow,
  .tile.dragging .tile-paint,
  .tile.dragging .tile-bar-fill,
  .tile.dragging .tile-bar-tip {
    transition: none;
  }

  /* ─── Surface de geste ───────────────────────────────────────────────── */
  .tile-surface {
    position: absolute;
    inset: 0;
    z-index: 1;
    /* Le défilement vertical de la page reste au navigateur ; l'horizontale
       est à nous. */
    touch-action: pan-y;
    cursor: ew-resize;
    -webkit-tap-highlight-color: transparent;
  }
  .tile-surface[aria-disabled='true'] {
    cursor: pointer;
  }
  .tile-surface:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: -4px;
    border-radius: var(--radius-2xl);
  }

  /* ─── Contenu ────────────────────────────────────────────────────────── */
  .tile-body {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    /* Bas dégagé pour le ruban (12 px + 6 px de haut + respiration). */
    padding: 14px 14px 26px;
    /* Le contenu ne doit pas manger le geste : seules les vraies commandes
       (interrupteur, bouton Réglages) réarment les événements pointeur. */
    pointer-events: none;
  }
  .tile-icon {
    display: flex;
    height: 44px;
    width: 44px;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-lg);
    background: var(--color-consumption-muted);
    color: var(--color-consumption);
    transition:
      background-color var(--duration-normal) var(--ease-default),
      color var(--duration-normal) var(--ease-default);
  }
  .tile.lit .tile-icon {
    background: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .tile-text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }
  .tile-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 600;
    color: var(--color-fg);
  }
  .tile-badge {
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .tile-state {
    font-size: 12.5px;
    color: var(--color-muted-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile-pct {
    margin-top: 4px;
    font-size: 28px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--color-fg);
  }
  .tile-pct.off {
    opacity: 0.4;
  }
  .tile-pct-unit {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }

  .tile-actions {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    align-items: flex-end;
    justify-content: space-between;
    gap: 10px;
    align-self: stretch;
    pointer-events: auto;
  }
  .tile-more {
    display: inline-flex;
    height: 36px;
    width: 36px;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-card-hover);
    color: var(--color-muted-fg);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .tile-more:focus-visible {
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
    .tile-glow,
    .tile-paint,
    .tile-bar-fill,
    .tile-bar-tip,
    .tile-icon,
    .toggle-pill-knob,
    .toggle-pill-knob::after {
      transition: none;
    }
  }
</style>
