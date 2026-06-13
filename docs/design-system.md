# Domo — Design System & conventions UI

> Référence pour **toute intervention sur l'interface** de Domo (SvelteKit + Tailwind v4, couleurs **OKLCH**). But : préserver la cohérence visuelle « Yeldra / OVNI » et ne pas défaire les choix calés. App **iOS-first** (iPhone **et** iPad).
>
> **Source de vérité : `src/app.css`** (`@theme` = tokens light + bloc `[data-theme='dark']` + règles glass/ambiance) et `src/lib/theme/animations.css`. Types TS via `$theme/tokens`.

Inspiration : [Yeldra](https://www.yeldra.com/) — profondeur premium, violet électrique, accent **vert « OVNI »**.

---

## 1. Philosophie

- **Profondeur, jamais « plat »** : surfaces teintées + reliefs marqués (indigo en sombre, dégradé bleu-vert en clair).
- Accent signature : **vert « OVNI »** (hue ~152) — lueurs, anneaux, ombres.
- C'est un **dashboard** : la **lisibilité prime** sur l'effet.
- Tout décor est **désactivable** (réglage Animations, `preferences.animationsEnabled`) et respecte `prefers-reduced-motion` / `prefers-reduced-transparency`.

## 2. Couleurs — tokens OKLCH (`src/app.css`)

- Marque : `--color-primary` violet `oklch(0.541 0.281 293)`.
- Vert OVNI : `--color-glow`, `--color-glow-bright`.
- **Énergie sémantique (ne pas changer le sens des couleurs)** : `--color-solar` (jaune), `--color-battery` / `--color-success` (vert), `--color-consumption` (bleu, hue 262), `--color-grid-energy` (gris), `--color-hp` / `--color-hc` (tarifs).
- **Modes cumulus** : `off` = gris muted, `pv` (surplus) = jaune solaire, `hc` = violet primary, `force` = violet clair.
- **Sombre** : `--color-bg oklch(0.205 …)` — **jamais quasi-noir** ; l'élévation se lit par des **surfaces plus claires**, pas par l'obscurité.
- **Clair** : fond de page = **dégradé vert→bleu** (cf. §5) ; cartes **neutres**, quasi opaques.
- **Règle d'or couleur** : jamais de **noir pur ni blanc pur** ; garder une teinte (hue ~286 indigo) et un chroma audible.
- **Sidebar = indigo immuable** (ne change pas avec le thème).

## 3. Glassmorphism « plexiglass » (cœur du design)

Toutes les cartes = **verre transparent à bords arrondis, éclairé par une source unique en HAUT-GAUCHE**.

**Mécanisme global (ne PAS recâbler par composant)** : une carte s'écrit `style="background: var(--color-card); border-color: var(--color-border);"`, et **une seule règle** dans `app.css` applique le verre à toutes :

```css
[style*='background: var(--color-card)'] {
  box-shadow: var(--shadow-md);
}
@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  [style*='background: var(--color-card)'] {
    -webkit-backdrop-filter: var(--glass-blur);
    backdrop-filter: var(--glass-blur);
  }
}
```

- `--color-card` est **translucide** ; `--glass-blur` = `blur(0px) saturate(…)` → verre **transparent** (pas dépoli), le `saturate` ravive le fond derrière.

**Éclairage dirigé = la signature du relief** (dans `--shadow-sm/md/lg`) :

- arête **lumineuse** en **haut+gauche** : `inset Npx Npx … oklch(0.78 0.17 262 …)` (bleu charte) ;
- arête **d'ombre** en **bas+droite** : `inset -Npx -Npx … oklch(… 152 …)` (vert) ;
- **ombre portée décalée bas-droite** (offsets x>0, y>0, 2 couches proche + large) ;
- - halo vert ambiant.
- ⚠️ **Toujours conserver cette direction** : lumière HG **bleue**, ombre BD **verte** (jamais noire). Des ombres symétriques = rendu plat.

**Valeurs calées (ne pas casser sans raison)** :

- **Sombre** : cartes ~20 % d'opacité, biseau bleu ~60 %, ombre verte marquée.
- **Clair** : cartes ~80 % (neutres), biseau bleu ~70 %, ombre verte ~30 %, biseau plus fin.
- `--shadow-sm/md/lg` sont **identiques** (recette unique).

## 4. Effets décoratifs OVNI (`src/lib/components/effects/`)

- `ParticleField.svelte` — particules vertes flottantes (canvas, sprite pré-rendu).
- `ConcentricRings.svelte` — anneaux concentriques avec **comète** (conic-gradient masqué en anneau fin + rotation continue lente, sens alternés).
- Lueurs latérales + liseré dans `FlowDiagram.svelte` (carte apport/usage).
- **Tous gated** : `preferences.animationsEnabled && !prefers-reduced-motion`, **en pause en arrière-plan** (`visibilitychange` / `document.hidden`).
- Placés sur **Accueil** + **/denied**. Pages denses (Énergie, Pièces, Climat) **laissées propres** (volontaire).

## 5. Calque de fond `.app-ambient`

`position: fixed; inset: 0; z-index: -1` dans `+layout.svelte` (**iOS-safe** : pas de `background-attachment: fixed`).

- **Sombre** : halos verts/indigo diffus (profondeur + matière pour le verre).
- **Clair** : **fond de page = dégradé linéaire vert→bleu**. Comme les cartes claires sont neutres (~80 %), le dégradé n'apparaît **que dans les zones vides**, **pas à travers les cartes**.

## 6. Responsive — iPhone-first, **ne pas oublier l'iPad paysage**

- Mobile : colonne unique + TabBar.
- `sm` : rail sidebar 72 px ; `lg` (≥1024 px = **iPad paysage**) : sidebar 280 px.
- **iPad paysage** : passer en **2 colonnes** (`lg:grid-cols-2`) — déjà fait sur Accueil (Sankey ‖ stats) et Énergie (graphes côte à côte). Toujours traiter ce cas.
- `overflow-x-clip` sur les pages à effets débordants (lueurs, anneaux).

## 7. Rafraîchissement des données (stores `src/lib/stores/*.svelte.ts`)

- Polling **visibility-aware** : **pause en arrière-plan** + **refetch immédiat au retour de visibilité** (principal gain de fraîcheur perçue). Pattern de référence : `printer.svelte.ts`.
- Cadences : **Anker 15 s** (le bridge cloud Solix ne se rafraîchit que ~60 s — poller plus vite côté bridge = inutile + **risque de ban** du compte), **APsystems 10 s** (lecture locale, cache 5 s), `forecast` 5 min.

## 8. Typographie

- Police unique : **Inter Variable** (`@fontsource-variable/inter`), `font-feature-settings: 'ss01','ss02','cv11'`, `tabular-nums`.
- Signature Yeldra : gros chiffres en graisse forte + libellés `uppercase` `tracking` discrets.
- `input/select/textarea` à `font-size: 16px` (anti-zoom iOS).

## 9. Spacing & Radius

- **Spacing** : grille 8 pt — gaps `gap-3`/`gap-4`/`gap-5`, padding interne `p-4` (tile) / `p-5` (grosse tile).
- **Radius** (tokens) : `--radius-2xl` (cards), `--radius-3xl` (grosses cards, signature), `--radius-pill` (boutons pilule).

## 10. Pièges techniques (déjà rencontrés)

- **`-webkit-backdrop-filter` obligatoire** (Safari/iOS).
- **`color-mix()` dans une `box-shadow` via `var()` casse le rendu sur Chrome** → interpoler les couleurs en **oklch calculé directement**.
- Respecter **`prefers-reduced-transparency`** : repli cartes opaques, sans flou.
- ⚠️ **Ne jamais `pnpm build` sans `sudo systemctl restart domo`** (le dossier `/home/laurent/domo` est à la fois dev **et** WorkingDirectory du service → 500 `ERR_MODULE_NOT_FOUND` sinon). `pnpm check` (svelte-check) est en lecture seule, sûr.

## 11. Règles d'or (ne jamais casser)

1. **Lisibilité d'abord** (contraste texte suffisant).
2. **Lumière en haut-gauche, ombre verte en bas-droite** — partout.
3. **Jamais** noir/blanc purs.
4. Tout effet animé = **gated** (Animations + reduced-motion) **et** pausé en arrière-plan.
5. **iOS-first**, mais vérifier **iPad paysage**.
6. **Centraliser dans `app.css`** : un seul réglage de token se propage à toute l'app.
