<script lang="ts">
  /**
   * Carte « Terrasse » — surface par défaut sur /pieces. Le ruban WLED : la
   * tuile montre les LIGNES DE LED elles-mêmes, une par ligne, dans la couleur
   * que la terrasse voit vraiment (teinte + blanc 4000K mélangés comme de la
   * lumière, cf. `lightColor`). Pas de halo sur la carte (retiré à la demande
   * de Laurent, 19/09/2026) : la lumière, ce sont les rubans. Tout le réglage
   * fin vit dans la feuille (WledSheet).
   *
   * Refonte du 19/09/2026 (Laurent : « trop d'infos inutiles, très moche
   * allumée, ne montre pas les lumières en service ni la température de
   * couleur »). L'ancienne tuile peignait la carte entière de l'aperçu direct
   * du module — que WLED BLANCHIT dès que le canal blanc est allumé (il ajoute
   * le blanc à chaque canal : un ambre + blanc arrivait en blanc pur) —, puis
   * la voilait de bleu nuit sous le texte : gris à gauche, olive à droite.
   * Surtitre, nom d'appareil, nom d'effet et gros pourcentage sont partis : il
   * reste le lieu, l'interrupteur, les réglages, et la lumière.
   *
   * Gestes (façon Maison iOS, mais à l'HORIZONTALE — le ruban est horizontal) :
   *   - glissé HORIZONTAL sur la tuile → luminosité, RELATIF au point de départ
   *     (plus de jauge sous le doigt pour viser une position absolue) ; le
   *     pourcentage s'affiche le temps du geste ;
   *   - tap (moins de 6 px de déplacement) → ouvre la feuille de réglages ;
   *   - l'interrupteur et le bouton Réglages restent des cibles à part.
   * `touch-action: pan-y` rend explicitement le défilement vertical de la page
   * au navigateur : la tuile ne crée pas de zone morte au milieu de /pieces.
   * Le Pager, lui, ne navigue qu'à DEUX doigts — aucun conflit ; `data-swipe-ignore`
   * est la ceinture en plus des bretelles.
   *
   * Musique : quand le mode joue, l'éclat des rubans suit le niveau sonore
   * serveur (var CSS `--mvol` en rAF, hors réactivité Svelte). Gated
   * `animationsEnabled` + `prefers-reduced-motion`, en pause en arrière-plan.
   */
  import { wled, WHITE_4000K, type RGB } from '$stores/wled.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';
  import { wledLeds } from '$stores/wledLeds.svelte';
  import { ledStrip } from '$lib/wled/led-strip';
  import { preferences } from '$stores/preferences.svelte';
  import {
    averageOfStops,
    familyOf,
    lightColor,
    paintStops,
    stateLabel,
    stopsToCss,
    vividTint,
    wrapStops
  } from '$lib/wled/preview-model';
  import { haptic } from '$utils/haptic';

  interface Props {
    /** Ouvre la feuille de réglages (tap sur la tuile ou bouton dédié). */
    onopen: () => void;
  }
  let { onopen }: Props = $props();

  // ─── Ligne « dominante » ───────────────────────────────────────────────
  // La plus longue effectivement allumée (à défaut, la plus longue tout
  // court). Chaque ligne est DESSINÉE à part plus bas ; celle-ci ne sert plus
  // qu'à l'état musique (légende, éclat qui respire).
  const dominant = $derived.by(() => {
    const segs = wled.segments;
    if (!segs.length) return null;
    const pool = segs.filter((s) => s.on);
    return (pool.length ? pool : segs).reduce((a, b) => (b.len > a.len ? b : a));
  });

  /**
   * Instantané musique VU PAR LA LIGNE PEINTE — pas l'état global.
   *
   * La tuile peignait la ligne dominante mais annonçait « Musique » dès que le
   * MODE était actif : avec la table en blanc chaud et le store qui danse, le
   * bandeau mentait sur la ligne qu'il montrait (constat de l'audit du 28/08 —
   * « les affichages ne reflètent pas la réalité »). `enabled` vaut désormais
   * « CETTE ligne suit la musique ».
   */
  const music = $derived({
    enabled: wledMusic.enabled && dominant !== null && wledMusic.lineStyle(dominant.id) !== null,
    analyzing: wledMusic.analyzing,
    trackKey: wledMusic.trackKey,
    playing: wledMusic.playing
  });
  /** Combien de lignes suivent la musique (légende « 1 ruban sur 2 »). */
  const musicLines = $derived(
    wledMusic.enabled ? wled.segments.filter((s) => wledMusic.lineStyle(s.id) !== null).length : 0
  );

  // Réduction de mouvement SYSTÈME, en état réactif : le MODÈLE en dépend —
  // sans mouvement il ne doit pas fabriquer la version bouclée du dégradé
  // (peinte en 200 % de large, une image statique n'en montrerait que la
  // moitié : un Sunset sans ses jaunes). Un matchMedia lu une fois manquerait
  // le changement du réglage en cours de vie.
  let reducedMotion = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const on = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  const motionOn = $derived(preferences.animationsEnabled && !reducedMotion);

  // Flux direct du module (couleur de chaque LED), refcounté et suspendu en
  // arrière-plan. Il ne sert qu'aux lignes SANS canal blanc : avec du blanc,
  // WLED l'ajoute à chaque canal de l'aperçu (qadd8) et tout vire au blanc.
  $effect(() => {
    wledLeds.open();
    return () => wledLeds.close();
  });

  // ─── Une ligne de LED = un ruban dessiné ───────────────────────────────
  interface Strip {
    id: number;
    start: number;
    len: number;
    lit: boolean;
    /** Aperçu direct fidèle pour cette ligne (pas de canal blanc). */
    live: boolean;
    paint: string;
    paintSize: string;
    glow: RGB;
    anim: string;
    animDur: number;
    sweep: boolean;
    spotDur: number;
    spotPaint: string;
  }

  function stripOf(seg: (typeof wled.segments)[number]): Strip {
    const lit = wled.on && seg.on;
    const fxName = wled.effects[seg.fx] ?? 'Solid';
    const palName = wled.palettes[seg.pal] ?? 'Default';
    // La couleur de la LUMIÈRE : teinte + blanc 4000K mélangés en linéaire, à
    // pleine luminance. C'est elle qui porte la température de couleur.
    const light = lightColor(seg.col, seg.white, WHITE_4000K);
    // Les couleurs que le ruban sort VRAIMENT quand l'effet/la palette est
    // multicolore (couleurs publiées par le firmware, `c1`/`c2`/`c3` de la
    // ligne), sinon `null` = la couleur de la ligne.
    const stops = lit
      ? paintStops({
          fxName,
          palName,
          palIndex: seg.pal,
          fxPalIndex: wled.fxDefaultPal[seg.fx],
          palettes: wled.paletteColors,
          c1: light,
          c2: seg.col2,
          c3: seg.col3
        })
      : null;
    // Lueur : la couleur de la lumière telle quelle — la « raviver » tordrait
    // justement sa température. Seule la moyenne d'un dégradé, grisâtre par
    // nature, est remontée en teinte.
    const glow = stops ? vividTint(averageOfStops(stops)) : light;
    const live = wledLeds.active && lit && seg.white === 0;

    // ─── Le MOUVEMENT de l'effet ────────────────────────────────────────
    // Même vocabulaire que la barre de la feuille (`familyOf`). Sans
    // mouvement (préférence Animations OFF, réduction système), tout reste en
    // famille « solid » : couleurs justes, image fixe, dégradé COMPLET. En
    // direct, les couleurs bougent d'elles-mêmes : pas d'animation par-dessus.
    const family = lit && motionOn && !live ? familyOf(fxName, stops) : 'solid';
    const speed = seg.sx / 255;
    let anim = '';
    let animDur = 0;
    let sweep = false;
    let spotDur = 0;
    if (family === 'scroll' && stops) {
      anim = 'anim-scroll';
      animDur = +(14 - speed * 11).toFixed(1); // ~3–14 s
    } else if (family === 'pulse') {
      anim = 'anim-pulse';
      animDur = +(4.5 - speed * 3.3).toFixed(1);
    } else if (family === 'flicker') {
      anim = 'anim-flicker';
      animDur = +(1.6 - speed * 1.2).toFixed(2);
    } else if (family === 'sweep') {
      sweep = true;
      spotDur = +(5 - speed * 3.8).toFixed(1);
    }
    // Le dégradé qui défile doit BOUCLER : wrapStops rejoue le premier arrêt à
    // la fin et on peint sur deux largeurs, sinon la couture saute à chaque tour.
    const loop = anim === 'anim-scroll' && stops;
    const spot: RGB = [
      Math.min(255, glow[0] + 110),
      Math.min(255, glow[1] + 110),
      Math.min(255, glow[2] + 110)
    ];
    return {
      id: seg.id,
      start: seg.start,
      len: seg.len,
      lit,
      live,
      paint: stops
        ? `linear-gradient(90deg, ${stopsToCss(loop ? wrapStops(stops) : stops)})`
        : `rgb(${light.join(' ')})`,
      paintSize: loop ? '200% 100%' : '100% 100%',
      glow,
      anim,
      animDur,
      sweep,
      spotDur,
      spotPaint: `linear-gradient(90deg, transparent, rgb(${spot.join(' ')}) 50%, transparent)`
    };
  }

  // Ordre PHYSIQUE (ligne 1 en haut) : c'est l'ordre du ruban.
  const strips = $derived([...wled.segments].sort((a, b) => a.start - b.start).map(stripOf));
  const anyLit = $derived(strips.some((s) => s.lit));

  // Légende : seulement ce que la lumière ne dit pas d'elle-même. Le nom de
  // l'effet (« Couleur fixe ») est parti — l'effet se VOIT sur les rubans ;
  // une ligne éteinte aussi (son ruban reste noir). Reste le mode Musique,
  // dont l'état (en pause, en attente de lecture…) ne se devine pas.
  const label = $derived.by(() => {
    if (!dominant) return wled.connected ? 'Aucun segment configuré' : 'Connexion au module LED…';
    if (!wled.on || musicLines === 0) return '';
    // Deux rubans, un seul sur la musique : le dire, plutôt que laisser croire
    // que toute la terrasse danse.
    if (musicLines < wled.segments.length)
      return `Musique · ${musicLines} ruban${musicLines > 1 ? 's' : ''} sur ${wled.segments.length}`;
    return stateLabel({ on: true, fxName: 'Solid', whiteOnly: false, music });
  });

  // Badge d'état SEULEMENT si anormal — « connecté » est l'état attendu.
  const abnormal = $derived(!wled.connected ? 'Hors ligne' : wled.isMock ? 'Démo' : null);

  // ─── Luminosité : niveau affiché (optimiste pendant le glissé) ─────────
  const briPct = $derived(Math.round((wled.bri / 255) * 100));
  let dragging = $state(false);
  let dragPct = $state(0);
  /* Éteinte, la valeur annoncée est 0 — pas la dernière luminosité mémorisée
     par le module. `briPct` reste la valeur de reprise interne (glissé,
     flèches clavier). */
  const shownPct = $derived(dragging ? dragPct : anyLit ? briPct : 0);
  /** Intensité de la lumière dessinée : 0 quand c'est éteint. */
  const level = $derived(anyLit ? shownPct : 0);

  // ─── Glissé horizontal = luminosité ────────────────────────────────────
  const SLOP = 6; // px avant de trancher entre « tap », « scroll » et « glissé »
  const SEND_MS = 90; // cadence max des POST pendant le glissé (le store gèle le resync)
  let surfEl = $state<HTMLDivElement | null>(null);
  let armed = false;
  let startX = 0;
  let startY = 0;
  let lastSent = 0;
  /** Point d'accroche du glissé : niveau et abscisse au moment où il a été tranché. */
  let dragBase = 0;
  let dragX0 = 0;

  /** Niveau RELATIF : la largeur de la tuile = 100 points, depuis l'accroche. */
  function pctFromX(clientX: number): number {
    const r = surfEl?.getBoundingClientRect();
    if (!r || r.width === 0) return shownPct;
    const pct = dragBase + ((clientX - dragX0) / r.width) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
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
      dragBase = briPct;
      dragX0 = e.clientX;
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

  // ─── Éclat qui respire avec la musique (--mvol, rAF) ───────────────────
  let hidden = $state(false);
  $effect(() => {
    if (typeof document === 'undefined') return;
    hidden = document.visibilityState === 'hidden';
    const onVis = () => (hidden = document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });

  // L'éclat ne respire que si LA LIGNE PEINTE danse vraiment (et pas parce
  // qu'un style global réactif traîne) — sinon l'écran et le ruban racontent
  // deux histoires différentes.
  const pulsing = $derived(
    anyLit &&
      dominant !== null &&
      wledMusic.reactiveFor(dominant.id) &&
      wledMusic.playing &&
      preferences.animationsEnabled &&
      !hidden
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
  class:lit={anyLit}
  class:dragging
  class:paused={hidden}
  style="background: var(--color-card); border-color: var(--color-border); --lvlf: {level / 100};"
>
  <!-- Toutes les couches lumineuses et la surface de geste sont bornées à CE
       bloc (`inset: 0`). -->
  <div class="tile-light">
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
      <div class="tile-text">
        <span class="tile-title">
          Terrasse
          {#if abnormal}
            <span
              class="tile-badge"
              style="color: {wled.connected ? 'var(--color-mandarine)' : 'var(--color-alert)'};"
            >
              {abnormal}
            </span>
          {/if}
        </span>
        {#if label}
          <span class="tile-state">{label}</span>
        {/if}
      </div>

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

      <!-- LES LIGNES DE LED : un ruban par ligne, dans l'ordre physique. Éteinte,
           une ligne reste un trait sombre — on voit ce qui est en service. -->
      <div class="tile-strips" aria-hidden="true">
        {#each strips as s (s.id)}
          <div
            class="strip"
            class:on={s.lit}
            class:live={s.live}
            style="--sglow: {s.glow.join(' ')};"
          >
            <div class="strip-light">
              {#if s.live}
                <!-- Les VRAIES LED de la ligne, une par une (lignes sans blanc). -->
                <canvas class="strip-leds" use:ledStrip={{ start: s.start, len: s.len }}></canvas>
              {:else}
                <div
                  class="strip-fill {s.anim}"
                  style="--paint: {s.paint}; --paint-size: {s.paintSize}; animation-duration: {s.animDur}s;"
                ></div>
              {/if}
              {#if s.sweep}
                <!-- Effets de balayage : le point qui traverse la ligne. -->
                <div
                  class="strip-spot"
                  style="background: {s.spotPaint}; animation-duration: {s.spotDur}s;"
                ></div>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <!-- Les rubans partagent la ligne du bouton Réglages : le bas de la
           carte, c'est la lumière et son réglage. -->
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

    <!-- Le niveau ne s'écrit que pendant le glissé : au repos, il se lit à
         l'intensité de la lumière. -->
    <span class="tile-drag tabular-nums" aria-hidden="true">
      {shownPct}<span class="tile-drag-unit"> %</span>
    </span>
  </div>
</div>

<style>
  .tile {
    position: relative;
    /* Colonne à un seul enfant : si la grille étire la tuile (voisine plus
       haute — l'imprimante sur /pieces), le bloc lumineux suit. */
    display: flex;
    flex-direction: column;
    /* La tuile se taille sur SA largeur (cf. « Tuile étroite » plus bas). */
    container-type: inline-size;
    overflow: hidden;
    border-width: 1px;
    border-style: solid;
    border-radius: var(--radius-2xl);
    /* Repos neutre quand la musique ne pilote pas l'éclat des rubans. */
    --mvol: 0.5;
  }
  .tile-light {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
  }

  /* ─── Les lignes de LED ──────────────────────────────────────────────── */
  /* Sur la ligne du bouton Réglages, centrés sur lui (cf. .tile-body). */
  .tile-strips {
    grid-area: 2 / 1;
    align-self: center;
    display: flex;
    flex-direction: column;
    /* 2 × 12 + 8 = 32 px : tient dans la hauteur du bouton Réglages (36). */
    gap: 8px;
    pointer-events: none;
  }
  /* Éteinte, la ligne reste là : un trait sombre. */
  .strip {
    position: relative;
    height: 12px;
    border-radius: 9999px;
    background: var(--color-muted);
  }
  /* Le halo de la ligne allumée — sur un calque à part : l'opacité suit le
     niveau (une box-shadow ne se dose pas en calc). */
  .strip::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      0 0 6px 1px rgb(var(--sglow) / 0.85),
      0 0 18px 4px rgb(var(--sglow) / 0.45);
    opacity: 0;
    transition: opacity var(--duration-normal) var(--ease-default);
  }
  /* Le halo suit le niveau (une ligne à 5 % doit être faible) et respire
     avec la musique (--mvol ; sans musique il vaut 0.5 → facteur 1). */
  .strip.on::after {
    opacity: calc((0.35 + var(--lvlf) * 0.65) * (0.55 + var(--mvol) * 0.9));
  }
  .strip-light {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    opacity: 0;
    transition: opacity var(--duration-normal) var(--ease-default);
  }
  /* Thème clair : la ligne allumée dans un profilé sombre de 1 px, comme le
     ruban dans son rail — sans lui, un blanc 4000K sur le verre clair
     disparaissait (crème sur blanc). Le thème sombre n'en a pas besoin : la
     nuit fait déjà le contraste, et le liseré y éteindrait le halo. */
  :global(html:not([data-theme='dark'])) .strip.on {
    background: oklch(0.3 0.03 262);
  }
  :global(html:not([data-theme='dark'])) .strip.on .strip-light {
    inset: 1px;
  }
  .strip.on .strip-light {
    opacity: 1;
    /* Le niveau se lit à l'intensité. L'aperçu direct porte déjà la
       luminosité du module : pas de double atténuation. */
    filter: brightness(calc(0.5 + var(--lvlf) * 0.5));
  }
  .strip.on.live .strip-light {
    filter: none;
  }
  /* Reflet de tube : la ligne se lit « LED allumée », pas « barre de couleur ». */
  .strip.on .strip-light::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, oklch(1 0 0 / 0.45), transparent 70%);
    pointer-events: none;
  }
  .strip-leds {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* Une LED = un rectangle net (jamais lissé par l'agrandissement). */
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }
  .strip-fill {
    position: absolute;
    inset: 0;
    background: var(--paint);
    background-size: var(--paint-size, 100% 100%);
    background-repeat: repeat-x;
  }
  /* Point lumineux des effets de balayage, clippé par la ligne. */
  .strip-spot {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 32%;
    transform: translateX(-120%);
    filter: blur(2px);
    will-change: transform;
  }

  /* ─── Mouvement des effets ───────────────────────────────────────────────
     Mêmes familles que la barre de la feuille : un dégradé qui défile, une
     respiration, un scintillement, un point qui balaie. Classes posées depuis
     le script (`anim`), durée tirée de la vitesse `sx` de la ligne. */
  .anim-scroll {
    animation-name: tile-scroll;
    animation-timing-function: linear;
    animation-iteration-count: infinite;
  }
  .anim-pulse {
    animation-name: tile-pulse;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;
    animation-direction: alternate;
  }
  .anim-flicker {
    animation-name: tile-flicker;
    animation-timing-function: steps(2, end);
    animation-iteration-count: infinite;
  }
  .strip-spot {
    animation-name: tile-sweep;
    animation-timing-function: ease-in-out;
    animation-iteration-count: infinite;
  }
  @keyframes tile-scroll {
    to {
      background-position: -200% 0;
    }
  }
  @keyframes tile-pulse {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes tile-flicker {
    0% {
      opacity: 0.6;
    }
    25% {
      opacity: 1;
    }
    50% {
      opacity: 0.72;
    }
    75% {
      opacity: 0.95;
    }
    100% {
      opacity: 0.65;
    }
  }
  @keyframes tile-sweep {
    from {
      transform: translateX(-120%);
    }
    to {
      transform: translateX(320%);
    }
  }

  /* Onglet en arrière-plan : on ARRÊTE de peindre (règle Domo — rien ne tourne
     dans le vide, surtout sur batterie). */
  .tile.paused .strip-fill,
  .tile.paused .strip-spot {
    animation-play-state: paused;
  }

  /* Pendant le glissé, la lumière suit le doigt SANS interpolation. */
  .tile.dragging .strip::after {
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
  /* Deux lignes, rien entre elles : le lieu et l'interrupteur, puis les
     rubans et le bouton Réglages. La hauteur est celle du contenu (~96 px) —
     plus de minimum : les 128 px d'avant laissaient une rangée vide au milieu. */
  .tile-body {
    position: relative;
    z-index: 2;
    display: grid;
    flex: 1;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    gap: 10px 12px;
    padding: 14px;
    /* Le contenu ne doit pas manger le geste : seules les vraies commandes
       (interrupteur, bouton Réglages) réarment les événements pointeur. */
    pointer-events: none;
  }
  .tile-body > .toggle-pill {
    grid-area: 1 / 2;
    pointer-events: auto;
  }
  .tile-body > .tile-more {
    grid-area: 2 / 2;
    pointer-events: auto;
  }
  .tile-text {
    grid-area: 1 / 1;
    align-self: center;
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }
  .tile-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
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
  /* Le pourcentage du glissé prend la place du nom, le temps du geste : la
     carte n'a plus de rangée libre pour lui. */
  .tile-drag {
    position: absolute;
    z-index: 2;
    top: 14px;
    left: 14px;
    font-size: 20px;
    font-weight: 700;
    line-height: 24px;
    letter-spacing: -0.02em;
    color: var(--color-fg);
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-default);
    pointer-events: none;
  }
  .tile.dragging .tile-drag {
    opacity: 1;
  }
  .tile-text {
    transition: opacity var(--duration-fast) var(--ease-default);
  }
  .tile.dragging .tile-text {
    opacity: 0;
  }
  .tile-drag-unit {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-muted-fg);
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

  /* ─── Tuile étroite (≈ 175 px : deux cartes de front sur iPhone) ───────── */
  @container (max-width: 239px) {
    .tile-body {
      gap: 10px;
      padding: 12px;
    }
    .tile-drag {
      top: 12px;
      left: 12px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .strip::after,
    .strip-light,
    .tile-drag,
    .tile-text,
    .toggle-pill-knob,
    .toggle-pill-knob::after {
      transition: none;
    }
    /* Les couleurs restent JUSTES, seul le mouvement disparaît. */
    .strip-fill,
    .strip-spot {
      animation: none !important;
    }
    .strip-spot {
      display: none;
    }
  }
</style>
