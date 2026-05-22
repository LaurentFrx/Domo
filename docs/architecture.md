# Architecture — Domo

## Vision

Progressive Web App familiale pour suivre et piloter l'énergie
de la maison (cumulus, production solaire, batterie).

## Stack

| Couche        | Choix               | Pourquoi                           |
| ------------- | ------------------- | ---------------------------------- |
| Framework     | SvelteKit 2         | Performance, simplicité, PWA-first |
| UI Layer      | Svelte 5 (Runes)    | Réactivité native sans Hooks       |
| Language      | TypeScript          | Type safety, refactoring sécurisé  |
| Styling       | Tailwind CSS 4      | Utility-first, rapide              |
| Tokens        | CSS Variables       | Compatibilité framework-agnostic   |
| Charts        | LayerCake           | Svelte-native, lightweight         |
| PWA           | @vite-pwa/sveltekit | Workbox modern, manifest auto      |
| Hosting       | Hetzner VPS         | Auto-héberge, contrôle total       |
| Reverse proxy | Caddy 2             | HTTPS auto via Let's Encrypt       |

## Structure

```
src/
├── routes/                  → Pages (file-based)
│   ├── +layout.svelte
│   ├── +page.svelte         → Dashboard
│   └── ...
├── lib/
│   ├── components/
│   │   ├── tiles/           → Cards principales
│   │   ├── charts/          → Graphiques
│   │   ├── layout/          → Header, TabBar
│   │   └── ui/              → Primitives (Badge, Gauge, ...)
│   ├── theme/               → Design tokens (CSS + TS)
│   ├── forecast/            → Provider Solcast (PV forecasting)
│   ├── stores/              → State global Svelte
│   └── utils/               → Helpers
```

## Phases

| Phase | Contenu                                             | Statut |
| ----- | --------------------------------------------------- | ------ |
| 1.1   | Scaffold + design system                            | ✅     |
| 1.2   | Composants dashboard mockés                         | ✅     |
| 1.3   | PWA setup (manifest, SW, icônes)                    | ⏳     |
| 1.4   | Solcast forecast provider                           | ✅     |
| 1.5   | Polish + déploiement Hetzner                        | ⏳     |
| 1.6   | Pages secondaires (Énergie, Pièces, Auto, Réglages) | ⏳     |
