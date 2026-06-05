<!--
  Champ de particules de fond (façon Yeldra) — blobs verts lumineux qui dérivent
  lentement vers le haut. Décoratif, donc aria-hidden.

  Performance & sobriété :
    - sprite « blob » pré-rendu une fois (drawImage ≫ shadowBlur par particule) ;
    - boucle requestAnimationFrame mise en PAUSE quand l'onglet est caché ;
    - rien ne tourne si l'utilisateur a coupé les animations (Réglages) ou si
      l'OS réclame un mouvement réduit (prefers-reduced-motion).

  À placer dans un parent `position: relative/absolute` qui définit la zone
  (le canvas occupe 100 % du parent).
-->
<script lang="ts">
  import { preferences } from '$stores/preferences.svelte';

  interface Props {
    /** Nombre de particules (densité). */
    count?: number;
    /** Couleur en triplet RGB « r, g, b ». Défaut : vert Yeldra. */
    color?: string;
  }
  let { count = 32, color = '90, 245, 170' }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let reducedMotion = $state(false);

  $effect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    const on = (e: MediaQueryListEvent) => (reducedMotion = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });

  $effect(() => {
    const el = canvas;
    const active = preferences.animationsEnabled && !reducedMotion;
    if (!el || !active) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Sprite « blob » lumineux (radial-gradient pré-rendu).
    const sprite = document.createElement('canvas');
    const SP = 40;
    sprite.width = SP;
    sprite.height = SP;
    const sctx = sprite.getContext('2d');
    if (!sctx) return;
    const grad = sctx.createRadialGradient(SP / 2, SP / 2, 0, SP / 2, SP / 2, SP / 2);
    grad.addColorStop(0, `rgba(${color}, 0.9)`);
    grad.addColorStop(0.35, `rgba(${color}, 0.35)`);
    grad.addColorStop(1, `rgba(${color}, 0)`);
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, SP, SP);

    interface P {
      x: number;
      y: number;
      vx: number;
      vy: number;
      size: number;
      a: number;
      tw: number;
      ph: number;
    }
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    let parts: P[] = [];
    let w = 0;
    let h = 0;

    function seed() {
      parts = Array.from({ length: count }, () => ({
        x: rnd(0, w),
        y: rnd(0, h),
        vx: rnd(-4, 4), // px/s
        vy: rnd(6, 20), // px/s (montée)
        size: rnd(6, 20),
        a: rnd(0.15, 0.5),
        tw: rnd(0.3, 0.9), // vitesse de scintillement
        ph: rnd(0, Math.PI * 2)
      }));
    }

    function resize() {
      const r = el!.getBoundingClientRect();
      w = r.width;
      h = r.height;
      el!.width = Math.max(1, Math.round(w * dpr));
      el!.height = Math.max(1, Math.round(h * dpr));
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (parts.length === 0) seed();
    }
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf = 0;
    let last = 0;

    function loop(t: number) {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
      last = t;
      ctx!.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.y -= p.vy * dt;
        p.x += p.vx * dt;
        p.ph += p.tw * dt;
        if (p.y < -p.size) {
          p.y = h + p.size;
          p.x = rnd(0, w);
        }
        if (p.x < -p.size) p.x = w + p.size;
        else if (p.x > w + p.size) p.x = -p.size;
        ctx!.globalAlpha = p.a * (0.7 + 0.3 * Math.sin(p.ph));
        ctx!.drawImage(sprite, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx!.globalAlpha = 1;
      raf = requestAnimationFrame(loop);
    }

    function start() {
      if (raf) return;
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ctx!.clearRect(0, 0, w, h);
    }

    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVis);
    start();

    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  });
</script>

<canvas bind:this={canvas} class="block h-full w-full" aria-hidden="true"></canvas>
