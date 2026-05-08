# Design System — Yeldra

Le design system est inspiré de [Yeldra](https://www.yeldra.com/),
agence Norry. Style : dark mode premium + violet électrique + vert menthe.

## Source de vérité

`src/lib/theme/tokens.css` — CSS custom properties.

`src/lib/theme/tokens.ts` — Re-export TypeScript pour usage en JS
(charts dynamiques, conditions, etc.).

## Couleurs principales

| Token | Hex | Usage |
|-------|-----|-------|
| `--primary-500` | `#6E45FF` | Brand, CTAs, glows |
| `--accent-500` | `#3DFD98` | Mode PV, highlights, charts |
| `--surface-base` | `#07001F` | Canvas app |
| `--surface-card` | `#302D3A` | Tiles, cards |
| `--text-primary` | `#FFFFFF` | Texte principal |
| `--text-secondary` | `#9895A1` | Labels, metadata |

## Modes cumulus (sémantique)

- `--mode-off` : gris `#9895A1`
- `--mode-pv` : vert menthe `#3DFD98`
- `--mode-hc` : violet `#6E45FF`
- `--mode-force` : violet clair `#8D6CFF`

## Typographie

System fonts pour respect de la plateforme :
SF Pro (iOS/macOS), Segoe UI (Windows), Roboto (Android).

Tailwind classes suffisent pour l'essentiel. Utiliser `font-light`
sur les gros chiffres (signature Yeldra).

## Spacing (8pt grid)

- `--space-2` (8px) : gap entre éléments
- `--space-3` (12px) : gap entre tiles
- `--space-4` (16px) : padding interne tile moyenne
- `--space-5` (20px) : padding interne grosse tile

## Radius

- `rounded-xl` (16px) : tiles moyennes
- `rounded-3xl` (24px) : grosses cards (signature)
- `rounded-full` : pill buttons (signature)
