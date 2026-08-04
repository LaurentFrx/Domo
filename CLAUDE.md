# CLAUDE.md — Domo

Dashboard domotique / énergie. **SvelteKit + Tailwind v4**, couleurs **OKLCH**. Service systemd `domo` → https://domo.feroux.fr. PWA **iOS-first** (iPhone **et** iPad). Design « Yeldra / OVNI ».

## ⚠️ Build & déploiement

- **On développe dans `/home/laurent/domo-dev`** (worktree git, branche `dev`, `.env` symlinké). `/home/laurent/domo` est la **PRODUCTION** : `WorkingDirectory` du service et cible de `deploy.yml` — on n'y écrit pas de code.
- Pourquoi : toute modif non commitée dans `/home/laurent/domo` **bloque le déploiement suivant** (`git checkout -B main origin/main` refuse d'écraser), et un `pnpm build` de test y met le travail en cours **en service** sans qu'on le décide. Les deux se sont produits le 04/08/2026.
- Dans le dossier de prod, le build est _in place_ → **ne jamais `pnpm build` sans enchaîner `sudo systemctl restart domo`** (sinon 500 `ERR_MODULE_NOT_FOUND`). En pratique : pousser sur `main` et laisser l'auto-deploy faire.
- `data/` n'est **pas** partagé entre les deux dossiers : il porte l'état vivant (cumulus, boucles SB3/APS, abonnements push, `planning.json`) en chemins **relatifs au WorkingDirectory**.
- `pnpm check` (svelte-check) est en **lecture seule**, sûr.

## UI / Design system

**Avant toute modification d'interface, lire `docs/design-system.md`** (référence complète). Points non négociables :

- **Verre « plexiglass »** : cartes transparentes, **éclairage dirigé HAUT-GAUCHE** — arête **bleue** (charte, hue 262) en haut-gauche, **ombre VERTE** (hue 152) en bas-droite + ombre portée bas-droite. Jamais d'ombres symétriques (= plat), jamais d'ombre noire. Mécanisme **centralisé** dans `src/app.css` via `[style*='background: var(--color-card)']` — ne pas recâbler par composant.
- **Couleurs** : tokens OKLCH dans `src/app.css` (`@theme` + `[data-theme='dark']`). **Jamais noir/blanc purs.** Dark = pas quasi-noir (`--color-bg` ~0.205). Light = fond de page **dégradé vert→bleu** (`.app-ambient`), cartes **neutres**. Sidebar indigo **immuable**. Couleurs énergie sémantiques **intactes**.
- **Effets OVNI** (`src/lib/components/effects/` : `ParticleField`, `ConcentricRings`, lueurs `FlowDiagram`) : toujours **gated** `preferences.animationsEnabled && !prefers-reduced-motion` **+ pause en arrière-plan**. Sur Accueil + `/denied` seulement ; pages denses laissées propres.
- **Responsive** : iPhone-first **mais toujours traiter l'iPad paysage** (`lg:grid-cols-2`).
- **iOS** : `-webkit-backdrop-filter` obligatoire ; respecter `prefers-reduced-transparency`.
- **Piège** : `color-mix()` dans une `box-shadow` via `var()` casse le rendu sur Chrome → interpoler en **oklch calculé directement**.

## Données / polling

Stores `src/lib/stores/*.svelte.ts` : polling **visibility-aware** (pause en arrière-plan + **refetch au retour de visibilité**). Cadences : **Anker 15 s** (mur cloud Solix ~60 s — ne pas accélérer la cadence du bridge : **risque de ban**), **APsystems 10 s** (local), `forecast` 5 min.

## Centralisation

Le thème vit dans `src/app.css` (tokens) — un seul réglage se propage partout. Effets réutilisables : `src/lib/components/effects/`. Toolkit graphes : `src/lib/utils/chart.ts` + `src/lib/components/charts/ChartHoverLayer.svelte`.
