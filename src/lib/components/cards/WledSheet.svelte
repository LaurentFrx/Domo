<script lang="ts">
  /**
   * Feuille de réglages de l'éclairage terrasse — piste B « Deux rubans »
   * (canevas Design adopté par Laurent le 29/08/2026).
   *
   * PRINCIPE : ce qui organise l'écran, c'est L'OBJET PHYSIQUE. Une carte par
   * ligne de ruban, portant TOUT son état — son interrupteur, sa luminosité
   * (glissé à même son ruban, peint de sa vraie couleur) et UNE ligne qui dit
   * ce qu'elle fait. Toucher cette ligne ouvre le choix de sa source.
   *
   * Pourquoi ça remplace les 5 onglets d'avant : le désordre ne venait pas du
   * nombre d'onglets mais de TROIS façons concurrentes de désigner une ligne
   * (la portée, l'onglet Lignes, les styles musicaux par ligne). Ici il n'en
   * reste qu'une : la carte.
   *
   * EXCLUSIVITÉ PAR CONSTRUCTION : les sources d'une ligne (ambiance, ma
   * couleur, un effet, sur la musique) sont un choix unique. Choisir une
   * ambiance pour la table retire la table de la musique — et ne touche pas
   * au store, qui continue de danser. Plus besoin d'expliquer une préséance :
   * elle se voit. (Avant, tout réglage manuel coupait la musique PARTOUT, en
   * silence — c'était la plainte principale.)
   *
   * VÉRITÉ : tout est lu sur l'état réel du module, poussé en temps réel par
   * le SSE (cf. wled.applyLive) — aucune surface n'affiche un état supposé.
   */
  import BottomSheet from '$components/ui/BottomSheet.svelte';
  import WledColorPicker from './WledColorPicker.svelte';
  import {
    wled,
    lineLabel,
    previewColor,
    WLED_AMBIANCES,
    type WledSegment
  } from '$stores/wled.svelte';
  import { averageOfStops, paintStops, stopsToCss, vividTint } from '$lib/wled/preview-model';
  import { wledMusic } from '$stores/wledMusic.svelte';
  import { acquire } from '$stores/refcount';
  import { haptic } from '$utils/haptic';
  import { WLED_MUSIC_STYLES } from '$lib/wled/music-styles';

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open, onClose }: Props = $props();

  // La feuille vit au LAYOUT (elle échappe au rail du Pager) : tant qu'elle
  // est ouverte, elle tient ses PROPRES références au store et au flux temps
  // réel — le refcount évite tout doublon avec /pieces ou le lecteur.
  $effect(() => {
    if (!open) return;
    const release = acquire(wled);
    wledMusic.openLive();
    return () => {
      release();
      wledMusic.closeLive();
    };
  });

  /** Ligne dont on choisit la source (null = vue principale). */
  let chooserId = $state<number | null>(null);
  /** Sous-panneau déplié dans le choix de source (une chose à la fois). */
  let expanded = $state<'none' | 'couleur' | 'effet'>('none');
  let fxQuery = $state('');
  let showAllFx = $state(false);

  // La feuille se ferme, ou la ligne disparaît (bascule Ensemble/Par ligne) :
  // on ne reste jamais sur un écran de réglage orphelin.
  $effect(() => {
    if (!open) {
      chooserId = null;
      expanded = 'none';
    }
  });
  $effect(() => {
    if (chooserId !== null && !wled.segments.some((s) => s.id === chooserId)) chooserId = null;
  });

  const segs = $derived(wled.segments);
  const ids = $derived(segs.map((s) => s.id));
  const chooser = $derived(segs.find((s) => s.id === chooserId) ?? null);
  const briPct = $derived(Math.round((wled.bri / 255) * 100));
  const effLoaded = $derived(wled.effects.length > 0);
  /** « Les lier » = un seul segment pilote tout le ruban. */
  const linked = $derived(segs.length <= 1);

  // ─── Effets curés (mêmes libellés FR qu'avant : la liste est calée) ───────
  const CURATED_FX: { label: string; names: string[] }[] = [
    { label: 'Fixe', names: ['Solid'] },
    { label: 'Respiration', names: ['Breathe'] },
    { label: 'Bougie', names: ['Candle', 'Candle Multi'] },
    { label: 'Feu', names: ['Fire 2012', 'Fire Flicker'] },
    { label: 'Scintillement', names: ['Twinklefox', 'Twinkle'] },
    { label: 'Arc-en-ciel', names: ['Rainbow'] },
    { label: 'Vagues', names: ['Colorwaves', 'Colorloop'] },
    { label: 'Poursuite', names: ['Running', 'Chase'] },
    { label: 'Balayage', names: ['Scanner', 'Scan'] },
    { label: 'Comète', names: ['Multi Comet', 'Meteor'] },
    { label: 'Aurore', names: ['Aurora'] },
    { label: 'Océan', names: ['Pacifica', 'Lake'] }
  ];
  const curatedFx = $derived(
    CURATED_FX.map((c) => {
      const idx = c.names.map((n) => wled.effects.indexOf(n)).find((i) => i >= 0) ?? -1;
      return { label: c.label, idx };
    }).filter((c) => c.idx >= 0)
  );
  const fxFiltered = $derived.by(() => {
    const q = fxQuery.trim().toLowerCase();
    return wled.effects
      .map((name, i) => ({ name, i }))
      .filter((e) => !q || e.name.toLowerCase().includes(q));
  });
  /** Libellé FR d'un effet quand il en a un, sinon son nom firmware. */
  function fxLabel(idx: number): string {
    const raw = wled.effects[idx];
    if (!raw) return 'Effet';
    return CURATED_FX.find((c) => c.names.includes(raw))?.label ?? raw;
  }

  // Ambiances proposées : « Éteint » est retiré de la grille — chaque carte a
  // son propre interrupteur, une ambiance qui éteint serait un piège.
  const ambiances = $derived(WLED_AMBIANCES.filter((a) => !a.off));

  // ─── Ce que fait une ligne, LU sur son état réel ─────────────────────────

  interface LineSource {
    kind: 'musique' | 'ambiance' | 'effet' | 'couleur';
    /** Ce que la carte affiche en gros (« Blanc chaud », « Sur la musique — Cascade »). */
    label: string;
    /** La précision en dessous, en mots simples. */
    sub: string;
    /** Pastille : couleur réelle de la ligne (null = pastille « musique »). */
    swatch: string | null;
  }

  function styleLabel(key: string | null): string {
    if (key === null) return '—';
    return WLED_MUSIC_STYLES.find((s) => s.key === key)?.label ?? key;
  }

  /**
   * Les couleurs que la ligne SORT vraiment — pas sa couleur de base.
   *
   * Piège vécu au premier rendu : « Coucher de soleil » peignait un ruban NOIR.
   * Ces ambiances-là ont une couleur de base nulle et tirent leurs couleurs de
   * leur PALETTE ; c'est le firmware qui les publie (`/json/palx`, chargées
   * dans `wled.paletteColors`). Même toolkit que la tuile de /pieces, pour que
   * les deux surfaces peignent le même ruban.
   */
  function segStops(s: WledSegment) {
    const fxName = wled.effects[s.fx] ?? 'Solid';
    const palName = wled.palettes[s.pal] ?? 'Default';
    return paintStops({
      fxName,
      palName,
      palIndex: s.pal,
      palettes: wled.paletteColors,
      c1: previewColor(s.col, s.white),
      c2: s.col2,
      c3: s.col3
    });
  }

  /** Peinture du ruban : le dégradé réel de la palette, sinon la teinte vive. */
  function segPaint(s: WledSegment): string {
    const stops = segStops(s);
    if (stops) return `linear-gradient(90deg, ${stopsToCss(stops)})`;
    const [r, g, b] = vividTint(previewColor(s.col, s.white));
    return `rgb(${r} ${g} ${b})`;
  }

  /** Couleur MOYENNE de la ligne (pastille, lueur) — jamais un noir trompeur. */
  function segCss(s: WledSegment): string {
    const stops = segStops(s);
    const [r, g, b] = vividTint(stops ? averageOfStops(stops) : previewColor(s.col, s.white));
    return `rgb(${r} ${g} ${b})`;
  }

  /**
   * Encre lisible SUR le ruban peint : un ruban jaune pâle avalait le
   * pourcentage écrit en blanc (constaté au premier rendu). On choisit
   * l'encre d'après la luminance réelle de la couleur, jamais par défaut.
   */
  function inkOn(s: WledSegment): string {
    const stops = segStops(s);
    const [r, g, b] = vividTint(stops ? averageOfStops(stops) : previewColor(s.col, s.white));
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.55 ? 'oklch(0.22 0.03 286)' : 'oklch(0.99 0 0)';
  }

  /** Ce que dit la pastille d'état, sans mentir sur la source. */
  function badgeLabel(kind: LineSource['kind']): string {
    return kind === 'musique'
      ? 'Musique'
      : kind === 'effet'
        ? 'Effet'
        : kind === 'couleur'
          ? 'Couleur'
          : 'Ambiance';
  }

  /** Un canal proche ? (tolérance : le module arrondit, les palettes dérivent) */
  function near(a: number, b: number, tol = 12): boolean {
    return Math.abs(a - b) <= tol;
  }

  /**
   * La source d'une ligne, DÉDUITE de son état module (jamais d'un souvenir
   * local). L'ordre compte : la musique d'abord (elle pilote réellement le
   * rendu), puis les ambiances connues, puis l'effet, puis la couleur libre.
   */
  function lineSource(s: WledSegment): LineSource {
    const mstyle = wledMusic.enabled ? wledMusic.lineStyle(s.id) : null;
    if (mstyle !== null) {
      const sub = wledMusic.analyzing
        ? 'Analyse du morceau en cours…'
        : wledMusic.playing
          ? 'Danse sur la musique en cours'
          : 'En attente d’une lecture';
      return {
        kind: 'musique',
        label: `Sur la musique — ${styleLabel(mstyle)}`,
        sub,
        swatch: null
      };
    }
    const fxName = wled.effects[s.fx] ?? 'Solid';
    const amb = ambiances.find((a) => {
      const names = Array.isArray(a.fx) ? a.fx : a.fx ? [a.fx] : [];
      if (names.length && !names.includes(fxName)) return false;
      if (a.col && !a.col.every((c, i) => near(c, s.col[i]))) return false;
      if (a.white !== undefined && !near(a.white, s.white, 20)) return false;
      return true;
    });
    if (amb) {
      return {
        kind: 'ambiance',
        label: amb.label,
        sub:
          fxName === 'Solid' ? 'Lumière fixe — ne suit pas la musique' : 'Ne suit pas la musique',
        swatch: segCss(s)
      };
    }
    if (fxName !== 'Solid') {
      return {
        kind: 'effet',
        label: fxLabel(s.fx),
        sub: wled.audioFx.has(s.fx)
          ? 'Effet sonore posé à la main — sombre sans musique'
          : 'Effet — ne suit pas la musique',
        swatch: segCss(s)
      };
    }
    return { kind: 'couleur', label: 'Ma couleur', sub: 'Lumière fixe', swatch: segCss(s) };
  }

  // ─── Choisir une source : l'exclusivité est appliquée ICI ────────────────

  /**
   * Une ligne prend une source MANUELLE : elle quitte la musique — elle
   * SEULE. Si plus aucune ligne ne suit, le mode musique se coupe pour de
   * bon (sinon le serveur garderait un mode actif sans objet).
   */
  function leaveMusic(segId: number): void {
    if (!wledMusic.enabled) return;
    const next: Record<string, string | null> = {};
    for (const id of ids) next[String(id)] = id === segId ? null : wledMusic.lineStyle(id);
    wledMusic.setLines(next);
    // Plus personne ne suit : on coupe le mode pour de bon, sinon le serveur
    // garde un mode actif sans objet (et le ruban un effet sonore orphelin).
    if (!ids.some((id) => next[String(id)] !== null)) wledMusic.setEnabled(false);
  }

  function pickAmbiance(segId: number, key: string): void {
    haptic('medium');
    leaveMusic(segId);
    void (linked ? wled.applyAmbiance(key) : wled.applyAmbianceTo(segId, key));
    chooserId = null;
  }

  /**
   * Ce ruban suit la musique — LUI SEUL. Chaque ligne reçoit une valeur
   * explicite : mode coupé jusque-là ⇒ les autres ne suivent pas (`null`),
   * sinon elles gardent exactement ce qu'elles faisaient.
   */
  function pickMusic(segId: number, styleKey: string): void {
    haptic('medium');
    const wasEnabled = wledMusic.enabled;
    const next: Record<string, string | null> = {};
    for (const id of ids) {
      next[String(id)] = id === segId ? styleKey : wasEnabled ? wledMusic.lineStyle(id) : null;
    }
    wledMusic.setLines(next);
    if (!wasEnabled) wledMusic.setEnabled(true);
    chooserId = null;
  }

  function openChooser(segId: number): void {
    haptic('light');
    expanded = 'none';
    showAllFx = false;
    fxQuery = '';
    chooserId = segId;
  }

  // ─── Luminosité d'une ligne : glissé à même son ruban ────────────────────
  // Horizontal, comme la tuile de /pieces (et comme le montre l'étude citée
  // au canevas : l'horizontal bat le vertical à tout âge sur ce geste).

  let dragId: number | null = null;

  function briFromEvent(ev: PointerEvent, el: HTMLElement): number {
    const r = el.getBoundingClientRect();
    const ratio = r.width > 0 ? (ev.clientX - r.left) / r.width : 0;
    return Math.max(0, Math.min(255, Math.round(ratio * 255)));
  }

  function rubanDown(ev: PointerEvent, s: WledSegment): void {
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    dragId = s.id;
    void wled.setSegBri(s.id, briFromEvent(ev, el));
  }
  function rubanMove(ev: PointerEvent, s: WledSegment): void {
    if (dragId !== s.id) return;
    void wled.setSegBri(s.id, briFromEvent(ev, ev.currentTarget as HTMLElement));
  }
  function rubanUp(ev: PointerEvent): void {
    if (dragId === null) return;
    dragId = null;
    haptic('light');
    (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
  }
  /** Clavier / VoiceOver : le ruban reste un vrai curseur. */
  function rubanKey(ev: KeyboardEvent, s: WledSegment): void {
    const step = ev.shiftKey ? 26 : 8;
    let v: number | null = null;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') v = s.bri + step;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') v = s.bri - step;
    else if (ev.key === 'Home') v = 0;
    else if (ev.key === 'End') v = 255;
    if (v === null) return;
    ev.preventDefault();
    void wled.setSegBri(s.id, Math.max(0, Math.min(255, v)));
  }
</script>

<BottomSheet
  {open}
  wide
  title={chooser ? lineLabel(chooser.name) : 'Terrasse'}
  onClose={() => (chooser ? (chooserId = null) : onClose())}
>
  <div class="scope">
    {#if segs.length === 0}
      <p class="empty">
        {wled.connected ? 'Aucune ligne configurée sur le module.' : 'Connexion au module LED…'}
      </p>
    {:else if chooser}
      {@render sourceChooser(chooser)}
    {:else}
      {@render mainView()}
    {/if}
  </div>
</BottomSheet>

<!-- ══════════════ VUE PRINCIPALE — une carte par ruban ══════════════ -->
{#snippet mainView()}
  <div class="stack">
    {#if !wled.connected}
      <p class="warn">Le module ne répond pas — les réglages ci-dessous ne partiront pas.</p>
    {/if}
    {#if wledMusic.enabled && wledMusic.beatError}
      <p class="warn">La lumière ne reçoit pas la musique : {wledMusic.beatError}</p>
    {/if}

    <!-- Le seul réglage qui vaut pour TOUTE la terrasse -->
    <div class="card master">
      <div class="master-top">
        <div
          class="bri-bar"
          role="slider"
          tabindex="0"
          aria-label="Luminosité générale"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={briPct}
          onpointerdown={(e) => {
            const el = e.currentTarget as HTMLElement;
            el.setPointerCapture(e.pointerId);
            dragId = -1;
            void wled.setBri(briFromEvent(e, el));
          }}
          onpointermove={(e) => {
            if (dragId === -1) void wled.setBri(briFromEvent(e, e.currentTarget as HTMLElement));
          }}
          onpointerup={(e) => {
            if (dragId === -1) {
              dragId = null;
              haptic('light');
              (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
            }
          }}
          onpointercancel={() => (dragId = null)}
          onkeydown={(e) => {
            const step = e.shiftKey ? 26 : 8;
            let v: number | null = null;
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = wled.bri + step;
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = wled.bri - step;
            else if (e.key === 'Home') v = 0;
            else if (e.key === 'End') v = 255;
            if (v === null) return;
            e.preventDefault();
            void wled.setBri(Math.max(0, Math.min(255, v)));
          }}
        >
          <span class="bri-fill" style="width: {briPct}%;"></span>
          <span class="bri-cap" style="left: calc({briPct}% - 3px);"></span>
          <span class="bri-text">
            <svg
              width="19"
              height="19"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="4" />
              <path
                d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2"
              />
            </svg>
            {briPct} %
          </span>
        </div>
        <button
          type="button"
          class="power"
          class:on={wled.on}
          aria-pressed={wled.on}
          aria-label={wled.on ? 'Éteindre la terrasse' : 'Allumer la terrasse'}
          onclick={() => {
            haptic('medium');
            void wled.setOn(!wled.on);
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M12 3v9" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
          </svg>
        </button>
      </div>

      {#if wled.canSplit}
        <div class="link-row">
          <span class="link-text">
            {linked
              ? 'Les deux rubans suivent le même réglage'
              : 'Les deux rubans sont réglés séparément'}
          </span>
          <span class="link-label">Les lier</span>
          <label class="sw" aria-label="Lier les deux rubans">
            <input
              type="checkbox"
              checked={linked}
              onchange={(e) => {
                haptic('medium');
                void wled.setScope(
                  (e.currentTarget as HTMLInputElement).checked ? 'together' : 'perLine'
                );
              }}
            />
            <span class="sw-knob"></span>
          </label>
        </div>
      {/if}
    </div>

    {#if !wled.on}
      <p class="hint off-hint">
        Le ruban est éteint — les réglages ci-dessous s'appliqueront à l'allumage.
      </p>
    {/if}

    <!-- Une carte par ruban : tout son état, à sa place -->
    {#each segs as s (s.id)}
      {@const src = lineSource(s)}
      {@const pct = Math.round((s.bri / 255) * 100)}
      <div class="card line" class:dim={!wled.on || !s.on}>
        <div class="line-head">
          <span class="line-name">{lineLabel(s.name)}</span>
          <span class="badge {src.kind}">{badgeLabel(src.kind)}</span>
          <span class="spacer"></span>
          <label class="sw" aria-label="Allumer / éteindre {lineLabel(s.name)}">
            <input
              type="checkbox"
              checked={s.on}
              onchange={(e) => {
                haptic('light');
                void wled.setSegOn(s.id, (e.currentTarget as HTMLInputElement).checked);
              }}
            />
            <span class="sw-knob green"></span>
          </label>
        </div>

        <!-- Le ruban EST le curseur : sa couleur réelle, remplie jusqu'à sa luminosité -->
        <div
          class="ruban"
          role="slider"
          tabindex="0"
          aria-label="Luminosité de {lineLabel(s.name)}"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={pct}
          style="--c: {segCss(s)}; --paint: {segPaint(s)}; --ink: {inkOn(s)};"
          onpointerdown={(e) => rubanDown(e, s)}
          onpointermove={(e) => rubanMove(e, s)}
          onpointerup={rubanUp}
          onpointercancel={() => (dragId = null)}
          onkeydown={(e) => rubanKey(e, s)}
        >
          <span class="ruban-fill" style="width: {pct}%;"></span>
          <span class="ruban-cap" style="left: calc({pct}% - 3px);"></span>
          <span class="ruban-pct">{pct} %</span>
        </div>

        <!-- LA ligne qui dit ce que fait ce ruban — et qui ouvre son choix -->
        <button type="button" class="source" onclick={() => openChooser(s.id)}>
          {#if src.swatch}
            <span class="source-dot" style="background: {src.swatch};" aria-hidden="true"></span>
          {:else}
            <span class="source-dot music" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 18V6l10-2v12" opacity="0" />
                <rect x="4" y="10" width="3" height="9" rx="1.2" />
                <rect x="9" y="6" width="3" height="13" rx="1.2" />
                <rect x="14" y="12" width="3" height="7" rx="1.2" />
                <rect x="19" y="8" width="2" height="11" rx="1" />
              </svg>
            </span>
          {/if}
          <span class="source-text">
            <span class="source-label">{src.label}</span>
            <span class="source-sub">{src.sub}</span>
          </span>
          <span class="chev" aria-hidden="true">›</span>
        </button>
      </div>
    {/each}

    <p class="hint">
      Glissez sur un ruban pour sa luminosité. Touchez sa ligne du bas pour changer ce qu'il fait.
    </p>
  </div>
{/snippet}

<!-- ══════════ CHOIX DE SOURCE — une seule chose à la fois ══════════ -->
{#snippet sourceChooser(s: WledSegment)}
  {@const src = lineSource(s)}
  <div class="stack">
    <button type="button" class="back" onclick={() => (chooserId = null)}>
      <span class="chev back-chev" aria-hidden="true">‹</span> Terrasse
    </button>

    <div class="card recap">
      <span class="recap-now">{src.label}</span>
      <span class="recap-sub">{src.sub}</span>
    </div>

    <p class="section">Ce que fait {lineLabel(s.name).toLowerCase()} — une seule chose à la fois</p>

    <!-- 1 · Ambiances -->
    <div class="amb-grid" role="group" aria-label="Ambiances">
      {#each ambiances as a (a.key)}
        <button
          type="button"
          class="amb"
          class:active={src.kind === 'ambiance' && src.label === a.label}
          onclick={() => pickAmbiance(s.id, a.key)}
        >
          <span class="amb-dot" style="background: {a.swatch};" aria-hidden="true"></span>
          <span class="amb-label">{a.label}</span>
        </button>
      {/each}
    </div>

    <!-- 2 · Ma couleur -->
    <button
      type="button"
      class="row"
      class:active={src.kind === 'couleur'}
      aria-expanded={expanded === 'couleur'}
      onclick={() => {
        haptic('light');
        expanded = expanded === 'couleur' ? 'none' : 'couleur';
      }}
    >
      <span class="row-text">
        <span class="row-label">Ma couleur…</span>
        <span class="row-sub">Choisir une teinte et le blanc</span>
      </span>
      <span class="chev" class:open={expanded === 'couleur'} aria-hidden="true">›</span>
    </button>
    {#if expanded === 'couleur'}
      <div class="panel">
        <WledColorPicker
          color={s.col}
          disabled={false}
          onpick={(rgb) => {
            leaveMusic(s.id);
            void wled.setSegColor(s.id, rgb);
            if (effLoaded && wled.solidFx >= 0 && s.fx !== wled.solidFx) {
              void wled.setSegEffect(s.id, wled.solidFx);
            }
          }}
        />
        {#if wled.rgbw}
          <div class="mini-row">
            <span class="mini-label">Blanc 4000 K</span>
            <input
              type="range"
              class="range"
              min="0"
              max="255"
              value={s.white}
              oninput={(e) => {
                leaveMusic(s.id);
                void wled.setSegWhite(s.id, +(e.currentTarget as HTMLInputElement).value);
              }}
              onchange={() => haptic('light')}
              aria-label="Canal blanc 4000 K"
            />
            <span class="mini-pct">{Math.round((s.white / 255) * 100)} %</span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- 3 · Un effet -->
    <button
      type="button"
      class="row"
      class:active={src.kind === 'effet'}
      aria-expanded={expanded === 'effet'}
      onclick={() => {
        haptic('light');
        expanded = expanded === 'effet' ? 'none' : 'effet';
      }}
    >
      <span class="row-text">
        <span class="row-label">Un effet…</span>
        <span class="row-sub">Bougie, Feu, Arc-en-ciel, Comète…</span>
      </span>
      <span class="chev" class:open={expanded === 'effet'} aria-hidden="true">›</span>
    </button>
    {#if expanded === 'effet'}
      <div class="panel">
        <div class="chips">
          {#each curatedFx as c (c.idx)}
            <button
              type="button"
              class="chip"
              class:active={s.fx === c.idx}
              onclick={() => {
                haptic('light');
                leaveMusic(s.id);
                void wled.setSegEffect(s.id, c.idx);
                void wled.setSegPalette(s.id, 0);
              }}
            >
              {c.label}
            </button>
          {/each}
        </div>
        {#if effLoaded && (wled.effects[s.fx] ?? 'Solid') !== 'Solid'}
          <div class="mini-row">
            <span class="mini-label">Vitesse</span>
            <input
              type="range"
              class="range"
              min="0"
              max="255"
              value={s.sx}
              oninput={(e) => {
                leaveMusic(s.id);
                void wled.setSegSpeed(s.id, +(e.currentTarget as HTMLInputElement).value);
              }}
              onchange={() => haptic('light')}
              aria-label="Vitesse de l'effet"
            />
          </div>
        {/if}
        <button
          type="button"
          class="disclosure"
          aria-expanded={showAllFx}
          onclick={() => (showAllFx = !showAllFx)}
        >
          <span>Tous les effets ({wled.effects.length})</span>
          <span class="chev" class:open={showAllFx} aria-hidden="true">⌄</span>
        </button>
        {#if showAllFx}
          <input
            type="search"
            class="search"
            placeholder="Rechercher un effet…"
            bind:value={fxQuery}
            aria-label="Rechercher un effet"
          />
          <div class="chips scroll" role="listbox" aria-label="Tous les effets">
            {#each fxFiltered as e (e.i)}
              <button
                type="button"
                class="chip"
                class:active={s.fx === e.i}
                role="option"
                aria-selected={s.fx === e.i}
                onclick={() => {
                  haptic('light');
                  leaveMusic(s.id);
                  void wled.setSegEffect(s.id, e.i);
                }}
              >
                {e.name}{#if wled.audioFx.has(e.i)}<span class="fx-note" aria-hidden="true"
                    >&nbsp;♫</span
                  >{/if}
              </button>
            {/each}
          </div>
        {/if}
        <!-- Les effets ♫ ne vivent que du flux musique : posés à la main sans
             lecture, le ruban reste noir et on croit à une panne. -->
        {#if effLoaded && wled.audioFx.has(s.fx) && !wledMusic.playing}
          <p class="hint">
            ♫ Cet effet a besoin de musique pour vivre. Sans lecture en cours, le ruban reste sombre
            — préférez « Sur la musique » ci-dessous.
          </p>
        {/if}
      </div>
    {/if}

    <!-- 4 · Sur la musique -->
    <p class="section">Sur la musique</p>
    <div class="chips" role="group" aria-label="Styles musicaux">
      {#each WLED_MUSIC_STYLES as st (st.key)}
        <button
          type="button"
          class="chip music"
          class:active={src.kind === 'musique' && wledMusic.lineStyle(s.id) === st.key}
          title={st.hint}
          onclick={() => pickMusic(s.id, st.key)}
        >
          {st.label}
        </button>
      {/each}
    </div>
    {#if segs.length > 1}
      {@const other = segs.find((o) => o.id !== s.id)}
      {#if other}
        <p class="hint">
          {lineLabel(other.name)} n'est pas touché : {lineSource(other).label.toLowerCase()}.
        </p>
      {/if}
    {/if}
  </div>
{/snippet}

<style>
  /* Le CONTENEUR de requête : les colonnes se décident sur la largeur du
     PANNEAU, pas de l'écran (la feuille est plafonnée — une requête média sur
     le viewport mettait deux colonnes dans 480 px sur iPad, cartes écrasées).
     ⚠️ Une requête de conteneur ne style JAMAIS son propre conteneur : d'où
     cette enveloppe autour de `.stack`. */
  .scope {
    container-type: inline-size;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .empty,
  .hint {
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--color-muted-fg);
  }
  .empty {
    padding: 16px 0;
    text-align: center;
  }
  .hint {
    text-align: center;
    margin: 0;
  }
  .off-hint {
    text-align: left;
  }
  .warn {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    font-weight: 600;
    color: oklch(0.72 0.17 27);
  }
  .section {
    margin: 2px 0 -4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted-fg);
  }
  .spacer {
    flex: 1;
  }

  /* ─── Cartes (verre Yeldra centralisé par app.css) ─── */
  .card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border-radius: var(--radius-2xl, 1rem);
    border: 1px solid var(--color-border);
    background: var(--color-card);
  }
  .card.dim {
    opacity: 0.62;
  }

  /* ─── Carte maître ─── */
  .master-top {
    display: flex;
    gap: 10px;
  }
  .bri-bar {
    position: relative;
    flex: 1;
    height: 60px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    overflow: hidden;
    cursor: ew-resize;
    touch-action: pan-y;
  }
  .bri-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: linear-gradient(90deg, oklch(0.55 0.09 78), oklch(0.82 0.13 78));
  }
  .bri-cap {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    border-radius: 4px;
    background: oklch(0.99 0 0 / 0.85);
  }
  .bri-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 15px;
    font-size: 24px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: oklch(0.22 0.03 286);
    pointer-events: none;
  }
  .power {
    width: 60px;
    flex-shrink: 0;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-muted-fg);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .power.on {
    background: oklch(0.541 0.281 293 / 0.22);
    border-color: oklch(0.72 0.2 293 / 0.6);
    color: oklch(0.86 0.14 293);
  }
  .link-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .link-text {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--color-muted-fg);
  }
  .link-label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }

  /* ─── Carte d'un ruban ─── */
  .line-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .line-name {
    font-size: 15px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .badge {
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11.5px;
    font-weight: 700;
    border: 1px solid currentColor;
  }
  .badge.ambiance,
  .badge.couleur {
    color: var(--color-ambre);
  }
  .badge.effet {
    color: var(--color-cyan);
  }
  .badge.musique {
    color: oklch(0.86 0.14 293);
  }

  .ruban {
    position: relative;
    height: 34px;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--c) 22%, transparent);
    box-shadow:
      0 0 16px color-mix(in oklch, var(--c) 50%, transparent),
      0 0 40px color-mix(in oklch, var(--c) 22%, transparent);
    overflow: hidden;
    cursor: ew-resize;
    touch-action: pan-y;
  }
  .ruban-fill {
    position: absolute;
    inset: 0 auto 0 0;
    /* Le dégradé RÉEL de la ligne (palette du firmware), pas sa couleur de
       base : « Coucher de soleil » a une base noire et des couleurs de feu. */
    background: var(--paint);
  }
  .ruban-cap {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    border-radius: 4px;
    background: var(--ink);
    opacity: 0.75;
  }
  .ruban-pct {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 13px;
    font-weight: 800;
    /* Encre calculée sur la luminance du ruban : lisible sur un jaune pâle
       comme sur un bleu profond. */
    color: var(--ink);
    pointer-events: none;
  }

  .source,
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 60px;
    padding: 11px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    text-align: left;
    cursor: pointer;
  }
  .row.active {
    border-color: var(--color-primary);
  }
  .source-dot {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid oklch(1 0 0 / 0.25);
  }
  .source-dot.music {
    display: flex;
    align-items: center;
    justify-content: center;
    background: oklch(0.541 0.281 293 / 0.25);
    color: oklch(0.86 0.14 293);
  }
  .source-text,
  .row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .source-label,
  .row-label {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .source-sub,
  .row-sub {
    font-size: 12px;
    line-height: 1.35;
    color: var(--color-muted-fg);
  }
  .chev {
    flex-shrink: 0;
    font-size: 20px;
    line-height: 1;
    color: var(--color-muted-fg);
    transition: transform var(--duration-fast, 120ms) ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }

  /* ─── Choix de source ─── */
  .back {
    align-self: flex-start;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 4px 2px;
    border: none;
    background: none;
    font-size: 14px;
    font-weight: 600;
    color: var(--color-primary-active, var(--color-primary));
    cursor: pointer;
  }
  .back-chev {
    font-size: 22px;
    color: inherit;
  }
  .recap {
    gap: 3px;
    padding: 12px 14px;
  }
  .recap-now {
    font-size: 15px;
    font-weight: 700;
    color: var(--color-fg);
  }
  .recap-sub {
    font-size: 12.5px;
    color: var(--color-muted-fg);
  }

  .amb-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }
  .amb {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 4px 2px;
    border: none;
    background: none;
    cursor: pointer;
  }
  .amb-dot {
    width: 54px;
    height: 54px;
    border-radius: 50%;
    border: 2px solid transparent;
  }
  .amb.active .amb-dot {
    border-color: oklch(0.99 0 0 / 0.9);
    box-shadow: 0 0 0 3px var(--color-primary);
  }
  .amb-label {
    font-size: 11.5px;
    line-height: 1.25;
    text-align: center;
    color: var(--color-muted-fg);
  }
  .amb.active .amb-label {
    color: var(--color-fg);
    font-weight: 700;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: oklch(0.5 0.03 286 / 0.1);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chips.scroll {
    max-height: 240px;
    overflow-y: auto;
  }
  .chip {
    min-height: 40px;
    padding: 7px 14px;
    border-radius: 9999px;
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .chip.active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .chip.music.active {
    box-shadow: 0 0 14px oklch(0.72 0.2 293 / 0.5);
  }
  .fx-note {
    color: var(--color-glow);
  }
  .disclosure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 44px;
    padding: 8px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: none;
    color: var(--color-fg);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .search {
    min-height: 40px;
    padding: 8px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-muted);
    color: var(--color-fg);
    font-size: 13px;
  }
  .mini-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mini-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-muted-fg);
  }
  .mini-pct {
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-fg);
  }
  .range {
    flex: 1;
    min-width: 0;
    height: 28px;
    accent-color: var(--color-primary);
  }

  /* ─── Interrupteur iOS (même dessin que partout dans Domo) ─── */
  .sw {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .sw input {
    position: absolute;
    inset: 0;
    z-index: 1;
    margin: 0;
    cursor: pointer;
    opacity: 0;
  }
  .sw-knob {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    background: var(--color-muted);
    border: 1px solid var(--color-border);
    transition: background-color var(--duration-fast, 120ms) ease;
  }
  .sw-knob::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: oklch(0.99 0.004 286);
    box-shadow: 0 1px 2px oklch(0.1 0.01 286 / 0.18);
    transition: transform var(--duration-normal, 200ms) var(--ease-spring, ease);
  }
  .sw input:checked + .sw-knob {
    background: var(--color-primary);
    border-color: var(--color-primary);
  }
  .sw input:checked + .sw-knob.green {
    background: var(--color-success);
    border-color: var(--color-success);
  }
  .sw input:checked + .sw-knob::after {
    transform: translateX(20px);
  }
  .sw input:focus-visible + .sw-knob,
  .bri-bar:focus-visible,
  .ruban:focus-visible,
  .source:focus-visible,
  .row:focus-visible,
  .chip:focus-visible,
  .amb:focus-visible,
  .power:focus-visible,
  .back:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  /* iPad paysage : les rubans côte à côte quand le PANNEAU est assez large. */
  @container (min-width: 680px) {
    .stack {
      display: grid;
      grid-template-columns: 1fr 1fr;
      align-items: start;
    }
    .card.master,
    .section,
    .hint,
    .warn,
    .back,
    .amb-grid,
    .panel,
    .recap {
      grid-column: 1 / -1;
    }
    /* La grille d'ambiances profite de la largeur : 7 d'un coup, pas 4+3. */
    .amb-grid {
      grid-template-columns: repeat(7, 1fr);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sw-knob,
    .sw-knob::after,
    .chev {
      transition: none;
    }
  }
</style>
