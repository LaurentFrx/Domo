/**
 * Design tokens Domo — version TypeScript.
 *
 * Source de vérité : @theme dans `src/app.css` (CSS custom properties OKLCH).
 * Ce module ré-exporte les valeurs pour la logique JS : LayerCake color scales,
 * conditions de mode, helpers de couleur sémantique.
 *
 * Style Yeldra v2 — fond light + sidebar dark + accents OKLCH.
 */

// ─── Couleurs sémantiques énergie ──────────────────────────────────────
export const semanticColors = {
  solar: { light: 'oklch(0.795 0.184 86)', dark: 'oklch(0.828 0.16 84.4)' },
  consumption: { light: 'oklch(0.546 0.215 262)', dark: 'oklch(0.65 0.16 262)' },
  battery: { light: 'oklch(0.627 0.194 149)', dark: 'oklch(0.70 0.15 149)' },
  grid: { light: 'oklch(0.708 0.012 280)', dark: 'oklch(0.55 0.01 280)' },
  hc: { light: 'oklch(0.541 0.281 293)', dark: 'oklch(0.646 0.235 293)' },
  hp: { light: 'oklch(0.6 0.118 25)', dark: 'oklch(0.7 0.1 25)' },
  alert: { light: 'oklch(0.577 0.245 27.3)', dark: 'oklch(0.704 0.17 22.2)' }
} as const;

export type EnergyDomain = keyof typeof semanticColors;
export type CumulusMode = 'OFF' | 'PV' | 'HC' | 'FORCE';

/** Renvoie le domaine sémantique correspondant à un mode cumulus. */
export function modeToColor(mode: CumulusMode): EnergyDomain {
  switch (mode) {
    case 'PV':
      return 'solar';
    case 'HC':
      return 'hc';
    case 'FORCE':
      return 'alert';
    default:
      return 'grid';
  }
}

/**
 * Renvoie une CSS var pour un mode cumulus (compat composants existants).
 * @deprecated Préférer `modeToColor(mode)` + `var(--color-{domain})`.
 */
export function modeColor(mode: CumulusMode): string {
  return `var(--color-${modeToColor(mode)})`;
}

// ─── Spacing 8pt grid ───────────────────────────────────────────────────
export const spacing = {
  s0: 0,
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
  s12: 48,
  s16: 64,
  s20: 80
} as const;

// ─── Radius (aligné --radius-* dans app.css) ───────────────────────────
export const radius = {
  sm: '0.375rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '0.875rem',
  '2xl': '1rem',
  '3xl': '1.5rem',
  pill: 9999
} as const;

// ─── Motion (aligné --duration-* / --ease-* dans app.css) ──────────────
export const duration = {
  fast: 100,
  normal: 200,
  slow: 300
} as const;

export const easing = {
  default: 'cubic-bezier(0.4, 0, 0.2, 1)',
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  out: 'cubic-bezier(0, 0, 0.2, 1)'
} as const;
