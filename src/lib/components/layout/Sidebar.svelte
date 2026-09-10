<script lang="ts">
  import { page } from '$app/state';
  import { navItems, isActive, type NavItem } from './nav-items';
  import {
    MENU_ICON,
    isMenuDestination,
    menuGroups,
    filterGroups,
    type MenuGroup,
    type MenuItem
  } from './menu-items';
  import { menuSheet, openMenu } from './menu-state.svelte';
  import { health } from '$stores/health.svelte';
  import { desk } from '$stores/desk.svelte';

  interface Section {
    title?: string;
    items: NavItem[];
  }

  // Mêmes entrées que la TabBar (source unique : nav-items.ts).
  const sections: Section[] = [{ title: 'Pilotage', items: navItems }];

  const inMenu = $derived(isMenuDestination(page.url.pathname));

  // ─── Bureau (desk:) : le tiroir ☰ est DÉPLIÉ dans la barre ────────────────
  // Sur un écran de bureau, la colonne a 1 300 px de hauteur pour 13 rubriques :
  // les cacher derrière une feuille coûtait deux gestes (ouvrir, choisir) pour
  // rien. Le rail de l'iPad, lui, garde le tiroir — 72 px ne portent pas de
  // libellés. La liste est celle du registre (menu-items.ts), icônes et teintes
  // comprises : une rubrique ajoutée là apparaît ici sans rien recâbler.
  let query = $state('');
  const isAdmin = $derived(page.data.user?.role === 'admin');
  function visibles(gs: MenuGroup[]): MenuGroup[] {
    if (isAdmin) return gs;
    return gs
      .map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly) }))
      .filter((g) => g.items.length > 0);
  }
  const filtering = $derived(query.trim().length > 0);
  const groups = $derived(visibles(filtering ? filterGroups(query) : menuGroups));
  // Les quatre onglets ne sont listés que si l'accueil N'EST PAS le tableau de
  // bord : là, leurs contenus sont les quatre colonnes (cf. DeskDashboard) et
  // les répéter n'aurait aucun sens. Dans une fenêtre plus étroite en revanche,
  // ils redeviennent la navigation — sans eux, Climat et Pièces ne seraient
  // plus atteignables que par la recherche. La recherche, elle, les trouve
  // toujours.
  // Synonyme de recherche : sur un poste de travail l'accueil s'appelle « tableau
  // de bord » (c'est ce qu'il montre), et personne ne tape « accueil » pour le
  // trouver. Le nom de l'app, en haut, y mène aussi.
  const SYNONYMES: Record<string, string> = { '/': 'tableau de bord' };
  const navHits = $derived(
    filtering
      ? navItems
          // Sur un poste de travail, « Bibliothèque musicale » EST /musique :
          // le lister deux fois pour la même page n'aide personne.
          .filter((n) => !(desk.is && n.href === '/musique'))
          .filter((n) =>
            normalize(`${n.label} ${SYNONYMES[n.href] ?? ''}`).includes(normalize(query.trim()))
          )
      : desk.is
        ? []
        : navItems
  );

  // La colonne « Ambiance » du tableau de bord ne porte que la lecture : la
  // bibliothèque (albums, artistes, recherche, playlists) reste une page, donc
  // une destination de la barre. Icône reprise du registre de navigation.
  const MUSIQUE_ICON = navItems.find((n) => n.href === '/musique')?.icon ?? '';
  // Doublon à éviter : hors tableau de bord, l'onglet « Musique » ci-dessous est
  // déjà la bibliothèque — cette entrée n'existe que pour la remplacer.
  const musiqueHit = $derived(
    !filtering || normalize('musique bibliotheque').includes(normalize(query.trim()))
  );
  const noHit = $derived(filtering && groups.length === 0 && navHits.length === 0 && !musiqueHit);
  function normalize(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }
  // Teintes des quatre pages de pilotage — même langage que les rubriques
  // (carré arrondi coloré), jetons --ios-* du kit Réglages.
  const NAV_TINT: Record<string, string> = {
    '/': 'var(--ios-blue)',
    '/climat': 'var(--ios-teal)',
    '/pieces': 'var(--ios-indigo)',
    '/musique': 'var(--ios-pink)'
  };

  const incidents = $derived(health.incidents.length);
  function itemActive(item: MenuItem): boolean {
    const p = page.url.pathname;
    return p === item.href || p.startsWith(item.href + '/');
  }
</script>

<!-- Rail 72 px de l'iPhone couché jusqu'à l'iPad PAYSAGE inclus ; la barre large
     (libellés) n'apparaît qu'au-delà de 1280 px À LA SOURIS, c'est-à-dire sur un
     vrai écran de bureau. Sur un iPad en paysage, 240 px de navigation pour
     5 entrées, c'est 20 % de la dalle prise à un contenu qui, lui, manque de
     place : le rail rend ces pixels au tableau de bord. -->
<aside
  class="sb safe-top fixed top-0 left-0 z-40 hidden h-screen w-[72px] flex-col sm:flex"
  aria-label="Navigation principale"
>
  <!-- Branding — et chemin du retour. Sur un poste de travail, l'accueil EST le
       tableau de bord : une entrée « Tableau de bord » dans la liste ferait
       doublon avec le nom de l'app, que tout le monde clique déjà par réflexe. -->
  <a
    href="/"
    class="sb-brand desk:justify-start desk:gap-2.5 desk:px-3.5 flex h-14 items-center justify-center px-5"
    aria-current={page.url.pathname === '/' ? 'page' : undefined}
    title={desk.is ? 'Tableau de bord' : 'Accueil'}
  >
    <img
      src="/icons/apple-touch-icon.png"
      alt=""
      width="28"
      height="28"
      class="h-7 w-7 rounded-lg"
      style="object-fit: cover;"
    />
    <span class="desk:inline hidden text-[14px] font-semibold tracking-tight"> Domo </span>
  </a>

  <!-- ═══ RAIL (iPad) : pilotage + tiroir ☰ ═══════════════════════════════ -->
  <nav class="desk:hidden flex flex-1 flex-col gap-4 px-2 pt-3 pb-4">
    {#each sections as section (section.title)}
      <div class="flex flex-col gap-0.5">
        {#each section.items as item (item.href)}
          {@const active = isActive(page.url.pathname, item.href)}
          <a
            href={item.href}
            class="sidebar-item relative flex items-center justify-center rounded-md transition-colors"
            class:sidebar-item-active={active}
            aria-current={active ? 'page' : undefined}
            title={item.label}
          >
            {#if active}
              <span
                class="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-r-full"
                style="background: var(--color-sidebar-active-border);"
                aria-hidden="true"
              ></span>
            {/if}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              class="shrink-0"
            >
              <path d={item.icon} />
            </svg>
          </a>
        {/each}
      </div>
    {/each}

    <button
      type="button"
      onclick={openMenu}
      class="sidebar-item sidebar-menu relative mt-auto flex items-center justify-center rounded-md transition-colors"
      class:sidebar-item-active={inMenu || menuSheet.open}
      aria-haspopup="dialog"
      aria-expanded={menuSheet.open}
      title="Menu — réglages et informations techniques"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        aria-hidden="true"
        class="shrink-0"
      >
        <path d={MENU_ICON} />
      </svg>
    </button>
  </nav>

  <!-- ═══ BUREAU : pilotage + toutes les rubriques, dépliées ══════════════ -->
  <div class="desk:flex hidden min-h-0 flex-1 flex-col">
    <div class="sb-search">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        type="search"
        bind:value={query}
        placeholder="Rechercher"
        aria-label="Rechercher une page ou un réglage"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </div>

    <nav class="sb-list" aria-label="Pages et réglages">
      {#if musiqueHit && desk.is}
        <span class="sb-sec">Ouvrir</span>
        {@const active = isActive(page.url.pathname, '/musique')}
        <a
          href="/musique"
          class="sb-item"
          class:sb-item-active={active}
          aria-current={active ? 'page' : undefined}
        >
          <span class="sb-ico" style="background: var(--ios-pink);">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d={MUSIQUE_ICON} />
            </svg>
          </span>
          <span class="sb-label">Bibliothèque musicale</span>
        </a>
      {/if}
      {#if navHits.length > 0}
        <span class="sb-sec">{desk.is ? 'Écrans' : 'Pilotage'}</span>
        {#each navHits as item (item.href)}
          {@const active = isActive(page.url.pathname, item.href)}
          <a
            href={item.href}
            class="sb-item"
            class:sb-item-active={active}
            aria-current={active ? 'page' : undefined}
          >
            <span class="sb-ico" style="background: {NAV_TINT[item.href] ?? 'var(--ios-gray)'};">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d={item.icon} />
              </svg>
            </span>
            <span class="sb-label">{item.label}</span>
          </a>
        {/each}
      {/if}

      {#each groups as group, gi (group.header ?? `g${gi}`)}
        {#if group.header || !(gi === 0 && musiqueHit && desk.is)}
          <span class="sb-sec">{group.header ?? 'Ouvrir'}</span>
        {/if}
        {#each group.items as item (item.href)}
          {@const active = itemActive(item)}
          <a
            href={item.href}
            class="sb-item"
            class:sb-item-active={active}
            aria-current={active ? 'page' : undefined}
            data-sveltekit-preload-data={item.hard ? 'off' : ''}
            data-sveltekit-reload={item.hard ? true : undefined}
            target={item.hard ? '_blank' : undefined}
            rel={item.hard ? 'noopener' : undefined}
          >
            <span class="sb-ico" style="background: {item.tint};">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d={item.icon} />
              </svg>
            </span>
            <span class="sb-label">{item.label}</span>
            {#if item.href === '/menu/systeme' && incidents > 0}
              <span class="sb-badge" aria-label="{incidents} anomalie(s)">{incidents}</span>
            {/if}
          </a>
        {/each}
      {/each}

      {#if noHit}
        <p class="sb-empty">Aucun résultat pour « {query} »</p>
      {/if}
    </nav>
  </div>

  <!-- User footer -->
  <div
    class="desk:flex desk:items-center desk:gap-2.5 hidden border-t px-4 py-3"
    style="border-color: oklch(1 0 0 / 0.07);"
  >
    <span
      class="inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold"
      style="background: var(--color-sidebar-accent); color: var(--color-sidebar-fg);"
      aria-hidden="true"
    >
      LF
    </span>
    <div class="flex flex-col leading-tight">
      <span class="text-[12px] font-semibold">Laurent Feroux</span>
      <span class="text-[11px]" style="color: var(--color-sidebar-muted);"> domo.feroux.fr </span>
    </div>
  </div>
</aside>

<style>
  /* ─── Matière ────────────────────────────────────────────────────────────
     iPad : la barre indigo PLEINE de la charte, inchangée.
     Bureau : la même teinte en VERRE — le halo d'ambiance passe au travers,
     comme une barre latérale macOS. Un seul élément flouté sur la page (et non
     une carte par carte, cf. app.css) : c'est tenable, et seulement à la souris. */
  .sb {
    background: var(--color-sidebar);
    color: var(--color-sidebar-fg);
    border-right: 1px solid oklch(0.25 0.015 280);
  }
  @media (min-width: 1280px) and (pointer: fine) {
    .sb {
      width: var(--sidebar-desk-w);
      background: var(--color-sidebar-glass);
      -webkit-backdrop-filter: blur(30px) saturate(180%);
      backdrop-filter: blur(30px) saturate(180%);
      border-right-color: oklch(1 0 0 / 0.07);
    }
  }
  /* « Réduire la transparence » (iOS/macOS) : on retombe sur l'indigo plein. */
  @media (prefers-reduced-transparency: reduce) {
    .sb {
      background: var(--color-sidebar);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  /* ─── Rail (iPad) ─────────────────────────────────────────────────────── */
  .sidebar-item {
    padding: 8px;
    color: var(--color-sidebar-muted);
    height: 36px;
  }
  .sidebar-menu {
    width: 100%;
    background: none;
    border: 0;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .sidebar-item:hover {
    background: var(--color-sidebar-hover);
    color: var(--color-sidebar-fg);
  }
  .sidebar-item-active {
    background: var(--color-sidebar-active);
    color: var(--color-sidebar-fg);
    font-weight: 600;
  }
  .sidebar-item:focus-visible {
    outline: 2px solid var(--color-sidebar-active-border);
    outline-offset: 2px;
  }

  /* ─── Bureau ──────────────────────────────────────────────────────────── */
  .sb-brand {
    color: inherit;
    text-decoration: none;
    transition: background-color var(--duration-fast) var(--ease-default);
  }
  .sb-brand:hover {
    background: oklch(1 0 0 / 0.06);
  }
  .sb-brand:focus-visible {
    outline: 2px solid var(--color-sidebar-active-border);
    outline-offset: -2px;
  }

  .sb-search {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    margin: 0 10px 4px;
    padding: 0 9px;
    border-radius: 7px;
    background: oklch(1 0 0 / 0.08);
    color: var(--color-sidebar-muted);
  }
  .sb-search input {
    flex: 1 1 auto;
    min-width: 0;
    background: none;
    border: 0;
    outline: none;
    font-size: 12.5px;
    color: var(--color-sidebar-fg);
  }
  .sb-search input::placeholder {
    color: var(--color-sidebar-muted);
  }
  .sb-search input::-webkit-search-cancel-button {
    -webkit-appearance: none;
  }

  .sb-list {
    display: flex;
    flex-direction: column;
    padding: 0 10px 12px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  .sb-sec {
    padding: 12px 10px 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-sidebar-muted);
  }
  .sb-item {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 32px;
    padding: 3px 10px;
    border-radius: 7px;
    color: oklch(0.9 0.02 286);
    transition:
      background-color var(--duration-fast) var(--ease-default),
      color var(--duration-fast) var(--ease-default);
  }
  .sb-item:hover {
    background: oklch(1 0 0 / 0.07);
    color: var(--color-sidebar-fg);
  }
  .sb-item:focus-visible {
    outline: 2px solid var(--color-sidebar-active-border);
    outline-offset: 2px;
  }
  .sb-item-active {
    background: var(--color-primary);
    color: var(--color-primary-fg);
    font-weight: 600;
    box-shadow: 0 1px 3px oklch(0.2 0.05 286 / 0.5);
  }
  .sb-item-active:hover {
    background: var(--color-primary);
    color: var(--color-primary-fg);
  }
  .sb-ico {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
    border-radius: 6px;
    color: oklch(0.99 0.012 286);
  }
  /* Cellule active : le carré coloré se fondrait dans le violet plein — on le
     rend translucide pour que l'icône reste lisible sans faire tache. */
  .sb-item-active .sb-ico {
    background: oklch(1 0 0 / 0.22) !important;
  }
  .sb-label {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13.5px;
    line-height: 1.25;
  }
  .sb-badge {
    flex: 0 0 auto;
    min-width: 18px;
    padding: 1px 6px;
    border-radius: 9999px;
    background: var(--color-alert);
    color: oklch(0.99 0.01 286);
    font-size: 11px;
    font-weight: 700;
    text-align: center;
  }
  .sb-empty {
    padding: 18px 10px;
    margin: 0;
    font-size: 12.5px;
    color: var(--color-sidebar-muted);
  }
</style>
