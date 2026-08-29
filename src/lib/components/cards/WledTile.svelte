<script lang="ts">
  /**
   * Carte « Terrasse » — surface par défaut sur /pieces. Le ruban WLED, bloc
   * `.tile-light` : la tuile EST la lumière, son fond se remplit de la couleur
   * réelle du ruban sur la largeur = la luminosité. Tout le réglage fin vit
   * dans la feuille (WledSheet). Le spot de la terrasse, lui, est une tuile
   * ordinaire sur la ligne des commandes rapides de /pieces — il n'a ni niveau
   * ni réglages, il n'a rien à faire dans cette carte.
   *
   * Le panneau de contrôle empilé (barre héros + luminosité + scènes + styles
   * musicaux + accordéon de réglages) coûtait 5 à 7 rangées au milieu d'une
   * page déjà dense ; le ruban se résume désormais à UN objet.
   *
   * ⚠️ Les couches lumineuses et la surface de geste sont en `inset: 0` sur
   * `.tile-light`, PAS sur la carte : c'est ce qui borne le glissé de
   * luminosité et le lavage coloré au bloc du ruban.
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
  import { wled, previewColor, type RGB } from '$stores/wled.svelte';
  import { wledMusic } from '$stores/wledMusic.svelte';
  import { preferences } from '$stores/preferences.svelte';
  import {
    averageOfStops,
    familyOf,
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

  const model = $derived.by(() => {
    const seg = dominant;
    if (!seg) {
      return {
        lit: false,
        paint: 'transparent',
        paintSize: '100% 100%',
        glow: '0 0 0',
        anim: '',
        animDur: 0,
        sweep: false,
        spotDur: 0,
        spotPaint: 'transparent',
        label: wled.connected ? 'Aucun segment configuré' : 'Connexion au module LED…'
      };
    }
    const lit = wled.on && seg.on;
    const fxName = wled.effects[seg.fx] ?? 'Solid';
    const palName = wled.palettes[seg.pal] ?? 'Default';
    // Les couleurs que le ruban sort VRAIMENT : celles que le firmware publie
    // pour cette palette, les couleurs de la ligne quand la palette s'y réfère
    // (`c1`/`c2`/`c3`), ou rien du tout quand l'effet ignore la palette. La
    // couleur 1 est passée EFFECTIVE (teinte + canal blanc) : le ruban est le
    // plus souvent en blanc 4000K pur, dont la teinte brute est noire.
    const stops = lit
      ? paintStops({
          fxName,
          palName,
          palIndex: seg.pal,
          fxPalIndex: wled.fxDefaultPal[seg.fx],
          palettes: wled.paletteColors,
          c1: previewColor(seg.col, seg.white),
          c2: seg.col2,
          c3: seg.col3
        })
      : null;
    // Sinon la TEINTE du segment, remontée à pleine luminance (`vividTint`) :
    // le niveau est porté par la largeur et la lueur, pas par la couleur.
    const tint = vividTint(previewColor(seg.col, seg.white));
    const glow = stops ? vividTint(averageOfStops(stops)) : tint;
    const whiteOnly = seg.col[0] === 0 && seg.col[1] === 0 && seg.col[2] === 0 && seg.white > 0;

    // ─── Le MOUVEMENT de l'effet ────────────────────────────────────────
    // Même vocabulaire que la barre de la feuille (`familyOf`) : une tuile qui
    // peindrait un « Feu » ou un « Balayage » en image fixe montrerait des
    // couleurs justes sur un ruban qui, lui, bouge. Vitesse dérivée de `sx`,
    // comme le module. Sans mouvement (préférence Animations OFF, réduction
    // système), tout reste en famille « solid » : couleurs justes, image fixe,
    // dégradé COMPLET — ni classe d'animation, ni version bouclée.
    const family = lit && motionOn ? familyOf(fxName, stops) : 'solid';
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
    // la fin (en comprimant le reste pour lui faire une vraie place) et on
    // peint sur deux largeurs, sinon la couture saute à chaque tour.
    const loop = anim === 'anim-scroll' && stops;
    const spotTint: RGB = [
      Math.min(255, glow[0] + 110),
      Math.min(255, glow[1] + 110),
      Math.min(255, glow[2] + 110)
    ];

    // Une ligne éteinte pendant que l'autre éclaire est invisible sur une
    // tuile-résumé : le dire, sinon l'utilisateur croit tout allumé.
    const offLines = wled.on ? wled.segments.filter((s) => !s.on).length : 0;
    const lines = offLines
      ? `${offLines} ligne${offLines > 1 ? 's' : ''} éteinte${offLines > 1 ? 's' : ''}`
      : '';
    // Ruban coupé : l'interrupteur ET le « 0 % » le disent déjà — un « Éteint »
    // écrit en toutes lettres serait la troisième fois. On ne garde ici que ce
    // qu'aucune autre partie de la tuile ne porte : l'effet en cours, et le
    // nombre de lignes restées éteintes alors que le reste éclaire.
    // Deux rubans, un seul sur la musique : le dire, plutôt que laisser croire
    // que toute la terrasse danse (ou qu'aucune ne le fait).
    const partial =
      musicLines > 0 && musicLines < wled.segments.length
        ? `Musique · ${musicLines} ruban${musicLines > 1 ? 's' : ''} sur ${wled.segments.length}`
        : '';
    const label = !wled.on
      ? ''
      : lit
        ? [partial || stateLabel({ on: true, fxName, whiteOnly, music }), lines]
            .filter(Boolean)
            .join(' · ')
        : lines;

    return {
      lit,
      paint: stops
        ? `linear-gradient(90deg, ${stopsToCss(loop ? wrapStops(stops) : stops)})`
        : `linear-gradient(90deg, rgb(${tint.join(' ')}), rgb(${tint.join(' ')}))`,
      paintSize: loop ? '200% 100%' : '100% 100%',
      glow: glow.join(' '),
      anim,
      animDur,
      sweep,
      spotDur,
      spotPaint: `linear-gradient(90deg, transparent, rgb(${spotTint.join(' ')}) 50%, transparent)`,
      label
    };
  });

  // Badge d'état SEULEMENT si anormal — « connecté » est l'état attendu.
  const abnormal = $derived(!wled.connected ? 'Hors ligne' : wled.isMock ? 'Démo' : null);

  // Le mouvement est arbitré DANS le modèle (motionOn) : classes d'animation
  // ET forme du dégradé vont ensemble. Seule la pause en arrière-plan reste en
  // CSS (.paused), pour ne pas reconstruire le modèle à chaque visibilité.

  // ─── Luminosité : niveau affiché (optimiste pendant le glissé) ─────────
  const briPct = $derived(Math.round((wled.bri / 255) * 100));
  let dragging = $state(false);
  let dragPct = $state(0);
  /* Éteinte, la tuile affiche « 0 % » — pas la dernière luminosité mémorisée
     par le module : le mot « Éteint » a été retiré au motif que l'interrupteur
     et le 0 % portent l'état, ce chiffre doit donc être VRAI. `briPct` reste
     la valeur de reprise interne (glissé, flèches clavier). */
  const shownPct = $derived(dragging ? dragPct : model.lit ? briPct : 0);
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

  // La lueur ne respire que si LA LIGNE PEINTE danse vraiment (et pas parce
  // qu'un style global réactif traîne) — sinon l'écran et le ruban racontent
  // deux histoires différentes.
  const pulsing = $derived(
    model.lit &&
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
  class:lit={model.lit}
  class:dragging
  class:paused={hidden}
  style="background: var(--color-card); border-color: var(--color-border); --lvl: {fillPct}%; --lvlf: {fillPct /
    100}; --paint: {model.paint}; --paint-size: {model.paintSize}; --glow: {model.glow};"
>
  <!-- ═══ LEDS — le ruban. Toutes les couches lumineuses et la surface de
       geste sont bornées à CE bloc : sans lui, le glissé de luminosité
       s'étendrait sous la rangée Spot et le lavage la déborderait. ═══ -->
  <div class="tile-light">
    <!-- Lueur ambiante : c'est la lumière qui déborde de la tuile. -->
    <div class="tile-glow" aria-hidden="true"></div>
    <!-- Lavage : peinture pleine largeur RÉVÉLÉE jusqu'au niveau (masque) — le
       dégradé reste ancré à la tuile au lieu d'être comprimé par la largeur.
       Le masque et l'opacité restent sur le cadre, le MOUVEMENT est porté par
       la couche interne : une animation d'opacité sur le cadre écraserait le
       dosage qui garde le texte lisible. -->
    <div class="tile-paint" aria-hidden="true">
      <div class="tile-paint-fill {model.anim}" style="animation-duration: {model.animDur}s;"></div>
      {#if model.sweep}
        <!-- Effets de balayage : le point qui traverse. Clippé par la tuile.
           N'existe que si le mouvement est permis (arbitré dans le modèle). -->
        <div
          class="tile-spot"
          style="background: {model.spotPaint}; animation-duration: {model.spotDur}s;"
        ></div>
      {/if}
    </div>
    <!-- Voile de lisibilité : la couleur étant désormais rendue pleine, le texte
       ne peut plus compter sur un fond de carte neutre. Le voile ne couvre que
       la colonne de gauche (texte) et s'efface avant le tiers droit, qui reste
       en couleur pure. -->
    <div class="tile-scrim" aria-hidden="true"></div>
    <!-- LE RUBAN : la lecture précise du niveau. Un lavage translucide sur fond
       sombre donne un brun sale, jamais « de la lumière » ; ce trait-là, lui,
       est vif et bloomé — c'est lui qui dit « allumé ». -->
    <div class="tile-bar" aria-hidden="true">
      <div class="tile-bar-fill {model.anim}" style="animation-duration: {model.animDur}s;"></div>
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
        <!-- La carte regroupe les deux lumières de la terrasse : le lieu passe
           en surtitre, les noms des appareils (« LEDS », « Spot ») deviennent
           les titres — sinon les deux rangées n'ont plus d'identité propre. -->
        <span class="tile-eyebrow">Terrasse</span>
        <span class="tile-title">
          LEDS
          {#if abnormal}
            <span
              class="tile-badge"
              style="color: {wled.connected ? 'var(--color-mandarine)' : 'var(--color-alert)'};"
            >
              {abnormal}
            </span>
          {/if}
        </span>
        {#if model.label}
          <span class="tile-state">{model.label}</span>
        {/if}
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
</div>

<style>
  /* --lvl ENREGISTRÉE pour être interpolable : un masque, un dégradé ou un
     `left` qui en dépendent ne s'animent pas d'eux-mêmes (mask-image et
     background s'animent en mode DISCRET — les lister dans une transition est
     sans effet). En transitionnant la VARIABLE, tout ce qui la lit — masques
     de niveau, lueur, tête du ruban — glisse d'un même mouvement. iOS ≥ 16.4,
     en deçà le niveau saute (dégradation acceptable). */
  @property --lvl {
    syntax: '<percentage>';
    inherits: true;
    initial-value: 0%;
  }

  .tile {
    position: relative;
    overflow: hidden;
    border-width: 1px;
    border-style: solid;
    border-radius: var(--radius-2xl);
    /* Repos neutre quand la musique ne pilote pas la lueur. */
    --mvol: 0.5;
    transition: --lvl var(--duration-normal) var(--ease-default);
  }
  /* Bloc LEDS : le référent de position de TOUTES les couches lumineuses
     (elles sont en `inset: 0`) et de la surface de geste. La rangée Spot vit
     hors de lui, donc hors du lavage et hors du glissé de luminosité. */
  .tile-light {
    position: relative;
    min-height: 128px;
  }
  /* Pendant le glissé, le niveau suit le doigt SANS interpolation. */
  .tile.dragging {
    transition: none;
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
    /* Le déplacement de la lueur suit --lvl (transitionnée sur .tile) ;
       `background` s'anime en discret, le lister ici serait sans effet. */
    transition: opacity var(--duration-normal) var(--ease-default);
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
    opacity: 0;
    /* La couleur tient FRANCHE sur l'essentiel de la zone allumée, puis se
       dissout sur la fin : un rectangle net à la coupe se lirait « barre de
       progression », mais une dissolution trop précoce délaverait justement
       les teintes qu'on veut montrer. La lecture exacte du niveau, c'est le
       ruban. */
    -webkit-mask-image: linear-gradient(
      90deg,
      #000 0,
      #000 calc(var(--lvl) * 0.72),
      transparent var(--lvl)
    );
    mask-image: linear-gradient(
      90deg,
      #000 0,
      #000 calc(var(--lvl) * 0.72),
      transparent var(--lvl)
    );
    /* Le masque suit --lvl (transitionnée sur .tile) ; mask-image s'anime en
       discret, le lister ici serait sans effet. */
    transition: opacity var(--duration-normal) var(--ease-default);
    pointer-events: none;
  }
  .tile.lit .tile-paint {
    /* PLEINE couleur : allumée, la tuile rend ce que le ruban éclaire — un
       lavage translucide sur la carte délavait les teintes (un Ocean virait
       au gris-bleu, un blanc 4000K au beige). La lisibilité du texte n'est
       plus obtenue en affadissant la lumière mais par le voile local
       (`.tile-scrim`), qui ne couvre que la colonne de texte. */
    opacity: 1;
  }
  /* Couche qui porte les COULEURS et le MOUVEMENT. Séparée du cadre pour que
     les animations d'opacité (pulsation, scintillement) se multiplient au
     dosage ci-dessus au lieu de l'écraser — sinon un « Feu » à 100 % ferait
     clignoter le fond jusque sous le texte. */
  .tile-paint-fill {
    position: absolute;
    inset: 0;
    background: var(--paint);
    background-size: var(--paint-size, 100% 100%);
    background-repeat: repeat-x;
  }
  /* Voile sous le texte. Indispensable dès lors que le fond rend la vraie
     couleur : elle peut être très sombre (Ocean, Lava) comme très claire
     (blanc 4000K, Pastel) — aucune couleur de texte ne tient sur les deux.
     Bleu-nuit et non noir (charte), et dégressif vers la droite pour laisser
     la lumière intacte là où rien n'est écrit. Le voile TIENT (≥ 0.5) jusqu'à
     64 % : la colonne de texte va jusqu'à ~80 % de la tuile (légendes longues
     « Musique · en attente de lecture ») — un fondu amorcé à 42 % laissait la
     fin des légendes passer sous la barre de contraste sur peinture claire. */
  .tile-scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      oklch(0.16 0.02 262 / 0.66) 0%,
      oklch(0.16 0.02 262 / 0.5) 64%,
      transparent 90%
    );
    opacity: 0;
    transition: opacity var(--duration-normal) var(--ease-default);
    pointer-events: none;
  }
  .tile.lit .tile-scrim {
    opacity: 1;
  }

  /* Point lumineux des effets de balayage — clippé par la tuile, et révélé
     jusqu'au niveau comme le reste (il hérite du masque du cadre). */
  .tile-spot {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 32%;
    transform: translateX(-120%);
    filter: blur(2px);
    will-change: transform;
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
    /* Même peinture que le fond : le ruban défile donc avec lui, sinon les
       deux raconteraient deux effets différents. */
    background-size: var(--paint-size, 100% 100%);
    background-repeat: repeat-x;
    /* Révélé jusqu'au niveau (% = largeur du ruban), dégradé non comprimé. */
    -webkit-mask-image: linear-gradient(
      90deg,
      #000 0,
      #000 calc(var(--lvl) - 3px),
      transparent var(--lvl)
    );
    mask-image: linear-gradient(90deg, #000 0, #000 calc(var(--lvl) - 3px), transparent var(--lvl));
    opacity: 0;
    /* Même logique que .tile-paint : c'est --lvl qui porte le glissement. */
    transition: opacity var(--duration-normal) var(--ease-default);
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
    /* PAS de transition sur `left` : left = var(--lvl), déjà lissée sur .tile
       — une seconde interpolation par-dessus ferait traîner la tête derrière
       le remplissage. */
    transition: opacity var(--duration-normal) var(--ease-default);
  }
  .tile.lit .tile-bar-tip {
    opacity: 1;
  }

  /* ─── Mouvement des effets ───────────────────────────────────────────────
     Mêmes familles que la barre de la feuille : un dégradé qui défile, une
     respiration, un scintillement, un point qui balaie. Les noms de classes
     sont posés depuis le script (`anim`), la durée vient de la vitesse `sx`
     du segment. */
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
  .tile-spot {
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
  .tile.paused .tile-paint-fill,
  .tile.paused .tile-bar-fill,
  .tile.paused .tile-spot {
    animation-play-state: paused;
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
  /* Surtitre du lieu — signature Yeldra (uppercase, tracking discret). */
  .tile-eyebrow {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
    line-height: 1.2;
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
  /* Allumée, la tuile est une surface COLORÉE : le texte passe en clair sur le
     voile, dans les deux thèmes — `--color-fg` suit le thème, pas la couleur
     du ruban, et virerait à l'illisible sur un fond sombre en thème clair. */
  .tile.lit .tile-title,
  .tile.lit .tile-pct {
    color: oklch(0.99 0.004 286);
    text-shadow: 0 1px 3px oklch(0.15 0.02 262 / 0.45);
  }
  .tile.lit .tile-eyebrow,
  .tile.lit .tile-state,
  .tile.lit .tile-pct-unit {
    color: oklch(0.94 0.008 262);
    text-shadow: 0 1px 2px oklch(0.15 0.02 262 / 0.4);
  }
  /* Le bouton Réglages tombe, lui, dans la zone restée en couleur pure : sans
     fond propre il se dissoudrait dedans. */
  .tile.lit .tile-more {
    border-color: oklch(1 0 0 / 0.4);
    background: oklch(0.16 0.02 262 / 0.42);
    color: oklch(0.98 0.004 286);
  }
  /* Le badge « Hors ligne »/« Démo » garde sa couleur SÉMANTIQUE (alerte /
     mandarine) — il ne peut donc pas passer en clair comme le reste du texte.
     Pastille à fond sombre local (même recette que .tile-more) : le seul
     témoin de panne de la tuile doit rester lisible sur peinture claire —
     c'est précisément allumée en ambre que la déconnexion se voit le moins. */
  .tile.lit .tile-badge {
    padding: 2px 7px;
    border-radius: 9999px;
    background: oklch(0.16 0.02 262 / 0.55);
    text-shadow: none;
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
    /* Les couleurs restent JUSTES, seul le mouvement disparaît. */
    .tile-paint-fill,
    .tile-bar-fill,
    .tile-spot {
      animation: none !important;
    }
    .tile-spot {
      display: none;
    }
  }
</style>
