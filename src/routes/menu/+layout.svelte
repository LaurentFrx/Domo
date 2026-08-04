<script lang="ts">
  /**
   * Coquille de l'espace « ☰ », calquée sur une pile de navigation iOS :
   * bouton retour bleu (« ‹ Menu ») puis GRAND TITRE de l'écran, sur fond gris
   * groupé. Bascule aussi la SURFACE (cf. app.css, html[data-surface='ios']).
   *
   * Ces pages n'appartiennent pas à navItems → jamais montées par le pager, donc
   * pas de swipe entre rubriques : on y entre par la feuille, on en sort par le
   * retour. C'est voulu — le geste 2 doigts reste réservé aux pages de pilotage.
   */
  import '$lib/styles/ios-settings.css';
  import { page } from '$app/state';
  import { menuLabelFor } from '$components/layout/menu-items';

  let { children } = $props();

  const label = $derived(menuLabelFor(page.url.pathname) ?? 'Menu');
  const isIndex = $derived(page.url.pathname === '/menu');

  // Surface « Réglages » : éteint le décor Yeldra (dégradé/halos) le temps du
  // séjour dans le menu, et le rallume en sortant. Attribut sur <html> → le fond
  // de page, le <body> et l'overscroll suivent d'un coup (règles dans app.css).
  $effect(() => {
    const html = document.documentElement;
    html.dataset.surface = 'ios';
    return () => {
      delete html.dataset.surface;
    };
  });
</script>

<div class="ios ml-page">
  <div class="ios-list">
    <header class="ml-head">
      {#if !isIndex}
        <a class="ios-back" href="/menu" data-sveltekit-preload-data>
          <svg
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
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Menu
        </a>
      {/if}
      <h1 class="ios-large-title">{label}</h1>
    </header>

    {@render children()}
  </div>
</div>

<style>
  /* La surface couvre l'écran même sur une rubrique courte, sinon le fond de
     l'app réapparaîtrait sous le dernier groupe.
     Gouttières : le layout parent applique déjà px-4 (16 px) = la marge des blocs
     « inset grouped » d'iOS ; le padding interne des cellules (16 px) s'y ajoute,
     ce qui pose le texte à 32 px du bord — exactement le rythme des Réglages. On
     ne touche donc PAS au padding horizontal ici, seulement au rythme vertical. */
  .ml-page {
    min-height: calc(100vh - 60px);
    padding: 4px 0 32px;
  }
  .ml-head {
    display: flex;
    flex-direction: column;
    padding-bottom: 4px;
  }
</style>
