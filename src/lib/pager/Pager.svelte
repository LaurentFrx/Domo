<script lang="ts">
  /**
   * Pager « pro iOS » : rail horizontal de 3 cellules [prev, current, next]
   * RÉELLES (montées via le registre, keyées par href → ZÉRO re-montage au commit),
   * piloté par une PHYSIQUE DE RESSORT seedée par la vitesse du doigt (continuité
   * geste→animation), INTERRUPTIBLE, avec snap par PROJECTION iOS et rubber-band.
   *
   * Modèle « rail rigide » (pas de parallaxe) = convention d'un pager d'onglets pairs
   * (photos/app-switcher iOS), et c'est ce qui rend le commit parfaitement sans couture :
   * au commit, `currentHref` change → la fenêtre se redéfinit → la cellule devenue
   * centrale GARDE son instance (keyée) et p repart à 0 sans aucun saut.
   *
   * Tout le mouvement n'écrit QUE `transform` (translate3d, GPU), de façon IMPÉRATIVE
   * dans la boucle rAF → aucun re-render Svelte par frame. La position `p` est sans
   * dimension (0 = centré, +1 = page suivante centrée, −1 = précédente), convertie en
   * pixels contre la largeur mesurée `W`.
   */
  import { onMount } from 'svelte';
  import { flushSync } from 'svelte';
  import { page } from '$app/state';
  import { pushState, preloadCode, afterNavigate } from '$app/navigation';
  import { navItems, isActive } from '$components/layout/nav-items';
  import PagerCell from './PagerCell.svelte';
  import { createSpring } from './spring';
  import { createVelocityTracker } from './velocity';
  import { haptic } from '$utils/haptic';
  import { pagerNav } from './pager-nav.svelte';

  // ── Page centrale (suit le routeur ET les commits) ──
  function routeHref(): string {
    return navItems.find((n) => isActive(page.url.pathname, n.href))?.href ?? '/';
  }
  // currentHref : source de vérité VISUELLE du pager, pilotée DIRECTEMENT au commit.
  // (pushState/shallow routing ne met PAS page.url à jour de façon fiable/synchrone
  // pour un changement de route → on ne peut pas en dépendre pour l'affichage.) La
  // synchro depuis le routeur (clics TabBar/Sidebar, back/forward) passe par
  // afterNavigate, qui ne se déclenche PAS pour le pushState d'un swipe → aucun combat.
  let currentHref = $state(routeHref());
  afterNavigate(() => {
    const h = routeHref();
    if (h !== currentHref) {
      currentHref = h;
      p = 0;
      applyTransform();
    }
  });
  const curIdx = $derived(navItems.findIndex((n) => n.href === currentHref));
  const windowItems = $derived(
    [navItems[curIdx - 1], navItems[curIdx], navItems[curIdx + 1]].filter(Boolean)
  );

  // Publie l'href central → TabBar/Sidebar/titre (page.url ne suit PAS le pushState).
  $effect(() => {
    pagerNav.current = currentHref;
  });

  // Pré-chargement des chunks voisins (prêts avant le geste). /maison exclue (3D).
  $effect(() => {
    for (const it of [navItems[curIdx - 1], navItems[curIdx + 1]]) {
      if (it && it.href !== '/maison') preloadCode(it.href);
    }
  });

  // ── Géométrie ──
  let viewportEl: HTMLElement;
  let railEl: HTMLElement;
  let W = 390;
  const spring = createSpring({ response: 0.25, damping: 0.86 });
  function measureW() {
    W = viewportEl?.clientWidth || window.innerWidth || 390;
    spring.restDelta = 0.5 / W; // arrêt au demi-pixel (adaptatif iPhone/iPad)
  }

  // ── Progression (impérative, hors réactivité Svelte) ──
  let p = 0;
  function applyTransform() {
    if (railEl) railEl.style.transform = `translate3d(${-p * W}px,0,0)`;
  }

  // ── Moteur ──
  const vtrack = createVelocityTracker();
  let mode: 'idle' | 'drag' | 'spring' = 'idle';
  let raf = 0;
  let lastFrame = 0;
  const REDUCED =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const hasNext = () => curIdx >= 0 && curIdx < navItems.length - 1;
  const hasPrev = () => curIdx > 0;

  // Rubber-band Apple (p-space) : rendement décroissant, asymptote 1 (≈ un écran).
  const rubber = (over: number) => 1 - 1 / (0.55 * over + 1);
  function clampRubber(np: number): number {
    if (np > 0 && !hasNext()) return rubber(np); // bout de liste droite
    if (np < 0 && !hasPrev()) return -rubber(-np); // bout de liste gauche
    return Math.max(-1, Math.min(1, np)); // dans la liste : une page max
  }

  // ── Ressort ──
  function startSpring(target: number, seedVel: number) {
    spring.setPosition(p);
    spring.setTarget(target);
    spring.seed(seedVel);
    if (REDUCED) {
      p = target;
      applyTransform();
      settle(target);
      return;
    }
    mode = 'spring';
    lastFrame = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }
  function frame(now: number) {
    const moving = spring.tick(now - lastFrame);
    lastFrame = now;
    p = spring.x;
    applyTransform();
    if (moving) {
      raf = requestAnimationFrame(frame);
    } else {
      mode = 'idle';
      settle(spring.target);
    }
  }
  // Fin de course : si on a atteint ±1 → on committe la page (fenêtre recentrée).
  function settle(target: number) {
    if (target === 1 && hasNext()) commit(navItems[curIdx + 1].href);
    else if (target === -1 && hasPrev()) commit(navItems[curIdx - 1].href);
    else {
      p = 0;
      applyTransform();
    }
  }
  function commit(href: string) {
    // currentHref ($state) en PREMIER → la fenêtre se redéfinit ; cellules keyées par
    // href → instances RÉUTILISÉES (zéro remount). flushSync applique MAINTENANT les
    // nouveaux offsets, puis p=0 : la nouvelle centrale est déjà à sa place (aucun saut).
    currentHref = href;
    flushSync();
    p = 0;
    applyTransform();
    window.scrollTo(0, 0); // nouvelle page en haut
    pushState(href, {}); // URL/historique (TabBar actif, titre, retour) — APRÈS le visuel
  }

  // ── Geste 2 doigts ──
  let armed = false;
  let locked = false;
  let startMidX = 0;
  let startMidY = 0;
  let startSpread = 0;
  let startP = 0;
  const mid = (t: TouchList, k: 'clientX' | 'clientY') => (t[0][k] + t[1][k]) / 2;
  const spread = (t: TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const ignored = (el: EventTarget | null) =>
    !!(el as Element | null)?.closest?.('[data-swipe-ignore]');

  function onStart(e: TouchEvent) {
    if (e.touches.length !== 2 || ignored(e.target)) {
      armed = false;
      locked = false;
      return;
    }
    // INTERRUPTIBILITÉ : on coupe un ressort en cours et on reprend la main sur p.
    if (mode === 'spring') {
      cancelAnimationFrame(raf);
      mode = 'idle';
    }
    measureW();
    armed = true;
    locked = false;
    startMidX = mid(e.touches, 'clientX');
    startMidY = mid(e.touches, 'clientY');
    startSpread = spread(e.touches);
    startP = p; // reprise RELATIVE (p peut être ≠ 0 si interruption) → pas de saut
    vtrack.reset();
    vtrack.sample(startMidX, performance.now());
  }
  function onMove(e: TouchEvent) {
    if (!armed || e.touches.length !== 2) return;
    const mx = mid(e.touches, 'clientX');
    const my = mid(e.touches, 'clientY');
    const dx = mx - startMidX;
    const dy = my - startMidY;
    if (Math.abs(spread(e.touches) - startSpread) > 40) {
      // pincement (zoom) → on abandonne
      armed = false;
      locked = false;
      return;
    }
    if (!locked) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return; // attendre l'intention
      if (Math.abs(dx) <= Math.abs(dy)) {
        armed = false; // geste vertical → laisser le scroll
        return;
      }
      locked = true;
      mode = 'drag';
    }
    if (e.cancelable) e.preventDefault();
    e.stopPropagation(); // coupe le 3D /maison (et tout handler enfant) une fois verrouillé
    vtrack.sample(mx, performance.now());
    // dx>0 (vers la droite) = page précédente → p diminue ; dx<0 = suivante → p augmente.
    p = clampRubber(startP - dx / W);
    applyTransform();
  }
  function onEnd() {
    if (!locked) {
      armed = false;
      return;
    }
    armed = false;
    locked = false;
    mode = 'idle';
    const vx = vtrack.velocity(performance.now()); // px/s (+ = droite)
    const vP = -vx / W; // dp/dt
    const pProj = p - (vx * 0.099) / W; // projection iOS (.fast, d=0.99 → ×99)
    const FLICK = 300; // px/s
    const flickNext = vx < -FLICK; // doigt file à gauche
    const flickPrev = vx > FLICK; // doigt file à droite
    let target = 0;
    if (p > 0 && hasNext()) {
      target = flickPrev ? 0 : pProj > 0.5 || flickNext ? 1 : 0;
    } else if (p < 0 && hasPrev()) {
      target = flickNext ? 0 : pProj < -0.5 || flickPrev ? -1 : 0;
    }
    if (target !== 0) haptic('light');
    startSpring(target, vP);
  }

  // ── Cycle de vie : mesure, listeners (capture pour devancer le 3D), resize ──
  onMount(() => {
    measureW();
    applyTransform();
    const onResize = () => {
      measureW();
      applyTransform();
    };
    // Filet : si l'app passe en arrière-plan en plein ressort, on finalise pour ne
    // pas figer (rAF suspendu). PAS un timer de durée.
    const onHide = () => {
      if (mode === 'spring') {
        cancelAnimationFrame(raf);
        const t = spring.target;
        p = t;
        applyTransform();
        mode = 'idle';
        settle(t);
      }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false, capture: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHide();
    });
    return () => {
      pagerNav.current = null; // pager démonté (sous-route) → repli routeur pour la TabBar
      cancelAnimationFrame(raf);
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove, true);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

<div class="pager-viewport" bind:this={viewportEl}>
  <div class="pager-rail" bind:this={railEl}>
    {#each windowItems as it (it.href)}
      {@const off = navItems.findIndex((n) => n.href === it.href) - curIdx}
      <div class="pager-cell" class:is-current={off === 0} style:left={`${off * 100}%`}>
        <div class="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8">
          <PagerCell href={it.href} active={off === 0} />
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  /* Clippe les voisines hors-cadre (pas de scroll horizontal du document). */
  .pager-viewport {
    position: relative;
    overflow-x: clip;
  }
  .pager-rail {
    position: relative;
    will-change: transform;
  }
  /* Voisines superposées hors-écran ; la centrale reste EN FLUX → porte la hauteur
     et le scroll vertical de la fenêtre. */
  .pager-cell {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    overflow: hidden; /* voisine clampée à la hauteur de la centrale (1er écran visible) */
  }
  .pager-cell.is-current {
    position: relative;
    bottom: auto;
    overflow: visible; /* la centrale porte la hauteur + le scroll vertical de la fenêtre */
  }
</style>
