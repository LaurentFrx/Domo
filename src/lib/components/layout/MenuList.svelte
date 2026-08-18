<script lang="ts">
  /**
   * Liste du menu « façon Réglages iOS » — groupes de cellules, icône en carré
   * arrondi coloré, valeur secondaire à droite, chevron, séparateurs décalés.
   *
   * PARTAGÉE par la feuille (☰) et la page /menu : sans ça les deux listes
   * divergeraient à la première rubrique ajoutée. Le parent fournit `onNavigate`
   * (la feuille s'en sert pour se fermer au tap) ; la page ne passe rien.
   *
   * Les valeurs de droite sont celles qu'iOS affiche en gris (« Général > iPhone ») :
   * on n'y met que ce qui est GRATUIT — préférences déjà hydratées et santé déjà
   * pollée app-wide. Aucun store lourd n'est connecté pour décorer une liste.
   */
  import { menuGroups, filterGroups, type MenuItem } from './menu-items';
  import { preferences } from '$stores/preferences.svelte';
  import { health } from '$stores/health.svelte';

  let { onNavigate, searchable = true }: { onNavigate?: () => void; searchable?: boolean } =
    $props();

  let query = $state('');

  const groups = $derived(query ? filterGroups(query) : menuGroups);
  const empty = $derived(groups.length === 0);

  const incidents = $derived(health.incidents.length);
  const themeValue = $derived(
    preferences.autoTheme ? 'Auto' : preferences.theme === 'dark' ? 'Sombre' : 'Clair'
  );

  /** Valeur grise de droite, si la cellule en a une. */
  function valueFor(item: MenuItem): string | null {
    if (item.href === '/menu/apparence') return themeValue;
    return null;
  }
</script>

{#if searchable}
  <div class="ios-search">
    <svg
      width="16"
      height="16"
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
      aria-label="Rechercher dans le menu"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
    />
    {#if query}
      <button
        type="button"
        class="ios-search-clear"
        onclick={() => (query = '')}
        aria-label="Effacer la recherche">✕</button
      >
    {/if}
  </div>
{/if}

{#each groups as group, gi (group.header ?? `g${gi}`)}
  <section class="ios-section">
    {#if group.header}
      <h2 class="ios-group-header">{group.header}</h2>
    {/if}
    <div class="ios-group">
      {#each group.items as item (item.href)}
        <a
          href={item.href}
          class="ios-cell has-icon"
          onclick={onNavigate}
          data-sveltekit-preload-data
        >
          <span class="ios-icon" style="background: {item.tint};">
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
              <path d={item.icon} />
            </svg>
          </span>
          <span class="ios-cell-text">
            <span class="ios-cell-label">{item.label}</span>
            {#if item.description}
              <span class="ios-cell-sub">{item.description}</span>
            {/if}
          </span>
          {#if item.href === '/menu/systeme' && incidents > 0}
            <span class="ios-badge" aria-label="{incidents} anomalie(s)">{incidents}</span>
          {:else if valueFor(item)}
            <span class="ios-cell-value">{valueFor(item)}</span>
          {/if}
          <svg
            class="ios-chevron"
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9 5l7 7-7 7" />
          </svg>
        </a>
      {/each}
    </div>
    {#if group.footer}
      <p class="ios-group-footer">{group.footer}</p>
    {/if}
  </section>
{/each}

{#if empty}
  <p class="ml-empty">Aucun résultat pour « {query} »</p>
{/if}

<style>
  .ml-empty {
    padding: 28px 16px;
    text-align: center;
    font-size: 15px;
    color: var(--ios-label2);
  }
</style>
