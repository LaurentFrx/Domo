# HA Dashboard — PWA

Progressive Web App pour piloter Home Assistant, conçue pour la famille Feroux.

## Cible

- **Production** : https://dashboard.feroux.fr
- **HA backend** : https://maison.feroux.fr

## Stack

- **Framework** : SvelteKit 2 + Svelte 5 (Runes)
- **Language** : TypeScript
- **Styling** : Tailwind CSS 4 + design tokens Yeldra (CSS vars)
- **Charts** : LayerCake (Svelte-native)
- **HA Client** : home-assistant-js-websocket
- **PWA** : @vite-pwa/sveltekit
- **Hosting** : Hetzner VPS + Caddy (HTTPS auto)

## Architecture

```
src/
├── routes/                  → Pages (file-based routing)
│   ├── +layout.svelte       → Layout avec tab bar
│   ├── +page.svelte         → Dashboard principal
│   ├── energie/             → Page Énergie
│   ├── pieces/              → Page Pièces
│   ├── auto/                → Page Automations
│   └── reglages/            → Page Réglages
├── lib/
│   ├── components/          → Composants UI réutilisables
│   │   ├── tiles/           → CumulusTile, SolarTile, BatteryTile
│   │   ├── charts/          → ProductionChart, etc.
│   │   ├── layout/          → TabBar, Header
│   │   └── ui/              → Button, Badge, Gauge primitives
│   ├── theme/               → Design tokens en CSS vars
│   ├── ha/                  → WebSocket + OAuth2 HA client
│   ├── stores/              → State Svelte (mode, données live)
│   └── utils/               → Helpers (formatage, dates…)
```

## Setup local

```bash
# Installer pnpm si nécessaire
npm install -g pnpm

# Installer les dépendances
pnpm install

# Lancer en mode dev (hot reload)
pnpm dev

# Build production
pnpm build

# Preview du build
pnpm preview
```

Le dev server tourne sur http://localhost:5173

## Déploiement Hetzner

```bash
# Sur le VPS
git clone https://github.com/LaurentFrx/ha-pwa.git
cd ha-pwa
docker compose up -d
```

Caddy gère HTTPS automatiquement via Let's Encrypt.

## Phases

| Phase | Contenu | Statut |
|-------|---------|--------|
| **1.1** | Scaffold + design system | ✅ Phase actuelle |
| **1.2** | Composants dashboard mockés | ⏳ À venir |
| **1.3** | PWA setup (manifest, SW, icônes) | ⏳ À venir |
| **1.4** | Connexion HA réelle (WS + OAuth2) | ⏳ À venir |
| **1.5** | Polish + déploiement Hetzner | ⏳ À venir |

## Documentation

- [Architecture détaillée](docs/architecture.md)
- [Design System](docs/design-system.md)
- [Déploiement Hetzner](docs/deployment.md)
