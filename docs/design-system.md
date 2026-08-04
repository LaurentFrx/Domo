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
- **Énergie sémantique (ne pas changer le sens des couleurs)** : `--color-solar` (jaune), `--color-battery` / `--color-success` (vert), `--color-consumption` (bleu, hue 262), `--color-grid-energy` (gris), `--color-hp` (corail — tarif Pleines **et** « chaud » : chauffage / confort / cumulus) / `--color-hc` (cyan — tarif Creuses). Orientation PV : `--color-sud` = `var(--color-mandarine)`, `--color-ouest` (violet).
- **Accents lumineux (réutilisables, toute l'app)** : `--color-mandarine` `oklch(0.8 0.2 60)`, `--color-ambre` `oklch(0.84 0.18 78)`, `--color-cyan` `oklch(0.82 0.15 200)`, `--color-magenta` `oklch(0.75 0.23 350)`, `--color-lime` `oklch(0.86 0.2 128)`. ⚠️ **Teinte bannie** : l'ocre-terracotta hue ~52 (« palette Anthropic », terne) — utiliser ces accents lumineux à la place.
- **Cumulus (voyant d'état)** : chauffe = `--color-hp` (corail / « chaud »), alimenté = `--color-success` (vert), éteint / hors-ligne = `--color-muted-fg` (gris). Pilotage **prédictif « observation »** — l'ancien sélecteur de modes colorés (`off`/`pv`/`hc`/`force`) n'existe plus.
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

## 10. Interactions tactiles — boutons « façon iOS » (centralisé)

Reproduit le bouton **natif iOS** (validé « sensation d'app pro »). Mécanisme **transverse, centralisé** : gestionnaire délégué unique dans `src/routes/+layout.svelte` (sur le `<div>` racine) + règles dans `src/app.css`. **Aucun câblage par composant** — tout `<button>` / `<a href>` / `[role="button"]` / `summary` en hérite.

- **Enfoncement au toucher** : `pointerdown` pose `data-pressed` sur les boutons/liens → CSS `[data-pressed] { transform: scale(0.96); opacity: 0.92 }`. **Instantané** (pas de `transition` : net comme en natif, et n'écrase pas les transitions de couleur des boutons). Switch/slider : **pas** d'enfoncement (ils basculent, ne s'enfoncent pas) — mais gardent le haptique.
- **Annulation drag-out** : si le doigt glisse hors du rect capturé au `pointerdown` (ou scroll / `pointercancel`) → on relâche l'enfoncement **et** l'action est annulée (= `touchDragExit` natif ; le `click` ne part que sur un `touchUpInside`).
- **Haptique de CONFIRMATION** : déclenché sur **`click`** (relâché _sur_ l'élément), donc **au moment de l'action** — pas au `pointerdown`. Bonus : les intensités explicites (`haptic('success')` d'un on/off) gagnent le dédoublonnage sur le `'light'` global au lieu d'être masquées. Opt-out : `data-no-haptic`.
- **Pas de délai artificiel** : la « latence » perçue = toucher→relâché + l'enfoncement (exactement comme en natif).

**Comportement « app native » (plus de réflexes web)** :

- `user-select: none` (body) + `-webkit-touch-callout: none` (html) + `img { -webkit-user-drag: none }` → supprime la sélection de texte, le menu long-press image/lien **et leur retour haptique SYSTÈME parasite**.
- **Réactivé** sur `input`, `textarea`, `[contenteditable]` et la classe utilitaire **`.selectable`** (à poser sur une valeur qu'on veut pouvoir copier).
- `touch-action: manipulation` sur les contrôles → fin du délai de tap 300 ms + zoom double-tap.

**Réglages faciles** : profondeur d'enfoncement = `scale()` de `[data-pressed]` (`app.css`) ; moment du haptique = `click` → `pointerdown` si un jour on le veut dès le toucher. Tout gated `prefers-reduced-motion`.

**Commande d'un objet : tuile + feuille** (motif de référence — `WledTile` / `WledSheet`, éclairage terrasse)

Un appareil riche ne s'étale pas en panneau de contrôle empilé au milieu d'une page dense. Il prend **une tuile** qui montre son état et porte les 2 gestes du quotidien, et **tout le reste va dans une `BottomSheet`** :

- **La tuile EST l'objet** : son fond porte l'état physique (ici la couleur réelle du ruban, remplie sur la largeur = luminosité). Allumée, la couleur est rendue **PLEINE** (04/08/2026) : le lavage translucide d'avant délavait justement ce qu'on veut montrer — un `Ocean` virait au gris-bleu, un blanc 4000K au beige. La couleur tient franche sur ~72 % de la zone allumée puis se dissout (un bloc net à la coupe se lirait « barre de progression »). La lecture **précise** du niveau reste portée par un élément vif dédié (le ruban en bas de la tuile).
- **Lisibilité du texte sur une surface colorée** : ne JAMAIS l'obtenir en affadissant la couleur. Voile local (`.tile-scrim`) limité à la colonne de texte et effacé avant le tiers droit, + texte clair dans les deux thèmes. La vraie couleur peut être très sombre (`Ocean`, `Lava`) comme très claire (blanc 4000K, `Pastel`) : aucune couleur de texte ne tient sur les deux sans voile, et `--color-fg` suit le thème, pas le ruban.
- **Teinte, pas couleur perçue** : pour teinter une surface **sans** couleur réelle disponible, normaliser la teinte à pleine luminance (`vividTint`, `$lib/wled/preview-model`). Une couleur déjà atténuée par la luminosité donne un **brun sale** (un blanc 4000K à mi-course = `rgb(132 115 99)`). Quand le firmware publie ses vraies couleurs, elles priment (`paintStops`).
- **Les effets se VOIENT** : un fond fidèle en couleur mais figé ment sur un ruban qui bouge. Familles de mouvement partagées (`familyOf`) : défilement, respiration, scintillement, balayage. Masque et opacité sur le cadre, mouvement sur une couche interne — sinon une animation d'opacité écrase le dosage qui protège le texte. Gating obligatoire : préférence Animations + `prefers-reduced-motion` (couleurs justes, mouvement supprimé) + pause en arrière-plan.
- **Glissé HORIZONTAL** pour la valeur continue, jamais vertical : `touch-action: pan-y` rend le défilement de la page au navigateur, sinon la tuile devient une zone morte. Le Pager ne navigue qu'à **deux doigts** → pas de conflit (+ `data-swipe-ignore` en ceinture). Trancher tap / scroll / glissé avec un seuil (~6 px) et ne capturer le pointeur **qu'après** avoir tranché.
- **Surface de geste et contenu séparés** : la surface `role="slider"` (avec `aria-valuenow`/`aria-valuetext` + flèches clavier) couvre la tuile ; le contenu est en `pointer-events: none` et seules les vraies commandes (interrupteur, bouton Réglages) le réarment. Le tap-partout ouvre la feuille, mais **un bouton explicite** doit toujours l'ouvrir aussi (chemin accessible).
- **Feuille = un SEUL niveau d'onglets.** Ce qui est vrai en permanence (aperçu, valeur, interrupteur) reste au-dessus des onglets ; imbriquer onglets + accordéon + sous-onglets, c'est le panneau empilé qui revient par la fenêtre.
- **Les feuilles descendent du HAUT** (04/08/2026) — posées en bas, leurs premiers réglages tombaient hors de portée sur iPhone. Conséquences à ne pas oublier en les touchant : zone sûre du **haut** (encoche / Dynamic Island), arrondis en bas, animation `translateY(-100%)`, et poignée iOS sur le bord **libre** (en bas, en `sticky` sinon une liste longue la rend invisible). ⚠️ Deux implémentations à garder d'accord : `BottomSheet` (verre Yeldra, 3 écrans) et `MenuSheet` (surface iOS, menu ☰) — la seconde ne réutilise PAS la première. Le nom `BottomSheet` est resté malgré l'ancrage haut.
- ⚠️ `focusout` est aussi émis quand le nœud focalisé est **retiré du DOM** (fermeture d'une feuille) : écrire un `$state` dans ce handler lève `state_unsafe_mutation` en plein démontage d'effets. Repousser d'une microtâche (cf. `TabBar`).

> Le haptique lui-même : hack `<label><input switch></label>` rendu en **sr-only** (1px + `clip`, mais dans l'arbre de rendu), cliqué via `label.click()` (`src/lib/utils/haptic.ts`). Android : `navigator.vibrate`. Prérequis appareil iOS : ≥ 17.4 + Réglages → Sons et vibrations → **« Vibrations système » activé** (sinon no-op silencieux). Reste un hack non officiel.

## 11. Pièges techniques (déjà rencontrés)

- **`-webkit-backdrop-filter` obligatoire** (Safari/iOS).
- **`color-mix()` dans une `box-shadow` via `var()` casse le rendu sur Chrome** → interpoler les couleurs en **oklch calculé directement**.
- Respecter **`prefers-reduced-transparency`** : repli cartes opaques, sans flou.
- ⚠️ **Ne jamais `pnpm build` sans `sudo systemctl restart domo`** (le dossier `/home/laurent/domo` est à la fois dev **et** WorkingDirectory du service → 500 `ERR_MODULE_NOT_FOUND` sinon). `pnpm check` (svelte-check) est en lecture seule, sûr.

## 11 bis. Surface « Réglages iOS » — l'espace menu ☰ (SEULE exception au design system)

Depuis le 03/08/2026, la barre de navigation ne porte plus que le geste quotidien — **Accueil, Climat, Pièces, Musique** — plus un bouton **☰**. Tout le reste (réglages, informations techniques, automatismes de fond, mais aussi **Énergie** et **Maison 3D**) vit derrière ce bouton. Le menu reproduit **l'app Réglages d'iOS** : c'est le seul endroit de Domo affranchi du langage Yeldra.

**Architecture**

- `src/lib/components/layout/menu-items.ts` — registre UNIQUE, en **groupes** (comme les sections des Réglages) : `header`, `footer`, cellules avec `icon` + `tint` (couleur système) + `keywords` (recherche). Une cellule marquée `external: true` pointe vers une page qui **garde le design de l'app** (`/energie`, `/maison`) : ce sont des écrans de données riches — graphes, Sankey, 3D — les habiller en liste de réglages n'aurait aucun sens. Elles portent en tête un retour « ← Menu ».
- `src/lib/components/layout/MenuList.svelte` — la liste, **partagée** par la feuille et la page `/menu` (sinon les deux divergent à la première rubrique ajoutée). Porte la recherche, qui **filtre réellement** (libellé + mots-clés métier, accents ignorés) — un champ inerte serait un faux affordance.
- `src/lib/components/layout/MenuSheet.svelte` — feuille modale iOS (grabber, coins 14 pt, bouton rond de fermeture), montée **une seule fois** dans `+layout.svelte`, ouverte par la TabBar (iPhone) et la Sidebar (iPad/desktop) via `menu-state.svelte.ts`.
- `src/lib/styles/ios-settings.css` — le kit `.ios-*`. Métriques réelles d'iOS : cellule **44 pt**, icône **29×29** (rayon 7), gouttière **16 pt**, rayon de groupe **10 pt**, séparateur **décalé à 60 pt** quand la cellule a une icône (16 + 29 + 15) et à 16 pt sinon, interrupteur **51×31** vert système. Typo `-apple-system` en tête de pile → **San Francisco sur iPhone/iPad**, la vraie police des Réglages (repli Inter ailleurs). Portée = tout descendant de `.ios`.
- `app.css` → `html[data-surface='ios']` (posé/retiré par `/menu/+layout.svelte`) : éteint `.app-ambient`, bascule `--color-bg`, et **aplatit les cartes réutilisées** (`--color-card` opaque, rayons 10 pt, `box-shadow: none`, pas de `backdrop-filter`).

⚠️ **Les valeurs de `html[data-surface='ios']` (app.css) et de `.ios` (ios-settings.css) DOIVENT rester alignées** — sinon une bande grise apparaît dans la gouttière des blocs.

**Pourquoi l'aplatissement compte** : les cartes techniques déplacées dans le menu (boucle SB3, bridage APS, Modbus local) sont des écrans **EN SERVICE** qui pilotent du réel — on ne les réécrit pas pour une question de rangement. Le thème les aplatit depuis l'extérieur, sans qu'une ligne de leur code ne bouge.

**Ce qui reste HORS de cette surface** : les écrans d'usage ouverts depuis une rubrique — `/planning` (« Mes matins », l'écran d'Isabelle), `/cumulus-labo`, et les pages `external`. Leur titre d'onglet vient de `pageTitleFor` (`menu-items.ts`), sauf si la page porte déjà son propre `<svelte:head><title>` (cas de `/planning`).

**Conséquence sur le pager** : le swipe 2 doigts ne balaie que les 4 pages de `navItems`. C'est ce qui a permis de supprimer le cas particulier WebGL de `/maison` dans `PagerCell`.

## 12. Règles d'or (ne jamais casser)

1. **Lisibilité d'abord** (contraste texte suffisant).
2. **Lumière en haut-gauche, ombre verte en bas-droite** — partout.
3. **Jamais** noir/blanc purs.
4. Tout effet animé = **gated** (Animations + reduced-motion) **et** pausé en arrière-plan.
5. **iOS-first**, mais vérifier **iPad paysage**.
6. **Centraliser dans `app.css`** : un seul réglage de token se propage à toute l'app.
7. **Boutons « façon iOS »** (§10) : l'enfoncement + le haptique de confirmation + l'anti-sélection sont **centralisés** (`+layout.svelte` + `app.css`) — ne pas les recâbler ni les casser par composant. Marquer `data-no-haptic` / `.selectable` au besoin.
8. **Le kit `.ios-*` (§11 bis) ne sort pas de `/menu`** — et réciproquement, aucune carte en verre n'entre dans le menu sans être aplatie par `html[data-surface='ios']`. Deux langages, une frontière nette : le pilotage Yeldra d'un côté, les Réglages iOS de l'autre.
