/**
 * Registre LAZY des composants `+page.svelte`, pour monter le VRAI contenu d'une
 * page voisine (pager) hors du routeur. Possible car les pages Domo sont
 * autonomes : aucune `load`/`+page.ts`, aucune dépendance à `page.url`/`data`.
 *
 * Glob lazy (fonctions `() => Promise`) → le chunk d'une voisine n'est chargé qu'à
 * son premier rendu. La page courante reste servie par le routeur (`children`,
 * SSR + hydratation correctes) ; seules les VOISINES passent par ici.
 *
 * /maison (3D Threlte) n'est volontairement PAS montée en voisine (cf. PagerCell) :
 * un seul contexte WebGL vivant, uniquement quand /maison est la page centrale.
 */
import type { Component } from 'svelte';

type Loader = () => Promise<{ default: Component }>;

// Deux globs explicites : '*' = une route de 1er niveau, + la racine (Accueil).
// On évite '**' (qui ratisserait les sous-routes type /reglages/planning, /denied).
const modules: Record<string, () => Promise<unknown>> = {
  ...import.meta.glob('/src/routes/+page.svelte'),
  ...import.meta.glob('/src/routes/*/+page.svelte')
};

function keyFor(href: string): string {
  return href === '/' ? '/src/routes/+page.svelte' : `/src/routes${href}/+page.svelte`;
}

/** Loader du composant de page pour un href de navItem, ou null si introuvable. */
export function loaderFor(href: string): Loader | null {
  return (modules[keyFor(href)] as Loader | undefined) ?? null;
}
