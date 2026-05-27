/**
 * Design tokens Domo — version TypeScript.
 *
 * Source de vérité : `tokens.css` (CSS variables).
 * Ce fichier expose les valeurs pour usage en TS (logique conditionnelle,
 * computations dynamiques, charts qui ont besoin des couleurs en JS).
 *
 * Style Yeldra (échelles 50→900, motion en 3 paliers, easings calibrés).
 */

// ─── Brand — Violet (échelle complète) ─────────────────────────────────
export const brand = {
  50: '#1A0A3E',
  100: '#2D1566',
  200: '#4A2599',
  300: '#5A35E0',
  400: '#6E45FF', // BASE
  500: '#8D6CFF',
  600: '#A990FF',
  700: '#C6B5FF',
  800: '#E3DBFF',
  900: '#F0EDFF'
} as const;

// ─── Accent — Vert menthe ──────────────────────────────────────────────
export const accent = {
  50: '#0A2E1A',
  100: '#134D2D',
  200: '#1E7A48',
  300: '#2DDD7E',
  400: '#3DFD98', // BASE
  500: '#3DFD98', // alias compat avec l'ancien --accent-500
  600: '#2DDD7E', // alias compat
  700: '#D9FEEB'
} as const;

// ─── Échelles exportées pour usage existant (rétro-compat) ─────────────
export const colors = {
  primary: {
    100: brand[800],
    200: brand[700],
    300: brand[600],
    400: brand[500],
    500: brand[400], // BASE
    600: brand[300]
  },
  accent: {
    100: '#D9FEEB',
    200: '#B3FED7',
    300: '#8DFDC3',
    500: accent[400], // BASE
    600: accent[300]
  },
  brand,
  accentScale: accent,
  surface: {
    base: '#07001F',
    elevated: '#080024',
    deep: '#090029',
    card: '#302D3A',
    cardHover: '#3A3744',
    darkest: '#111111'
  },
  text: {
    primary: '#FFFFFF',
    secondary: '#9895A1',
    tertiary: '#666666',
    muted: 'rgba(80, 76, 94, 0.5)'
  },
  mode: {
    off: '#9895A1',
    pv: '#3DFD98',
    hc: '#6E45FF',
    force: '#8D6CFF'
  }
} as const;

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

// ─── Radius rem-based (Yeldra) ─────────────────────────────────────────
export const radius = {
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  '2xl': '1.5rem',
  pill: 9999,
  // Aliases legacy (anciens noms pixel)
  xs: 2,
  xl2: '1.5rem'
} as const;

// ─── Motion — durées en 3 paliers ──────────────────────────────────────
export const duration = {
  short: 100,
  default: 200,
  long: 640
} as const;

// ─── Motion — easings calibrés ─────────────────────────────────────────
export const easing = {
  /** In-out sinusoïdal — neutre, pour micro-interactions */
  default: 'cubic-bezier(0.46, 0.03, 0.52, 0.96)',
  /** Quartic — plus expressif, entrées de page et transitions importantes */
  quart: 'cubic-bezier(0.77, 0, 0.18, 1)',
  /** Spring — overshoot léger pour les éléments réactifs */
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
} as const;

// ─── Shadows multi-couches ─────────────────────────────────────────────
export const shadow = {
  subtle: '0px 1px 3px 0px rgba(0, 0, 0, 0.2)',
  card: '0px 4px 12px 0px rgba(0, 0, 0, 0.2), 0px 2px 4px 0px rgba(0, 0, 0, 0.15)',
  elevated:
    '0px 16px 48px 0px rgba(0, 0, 0, 0.25), 0px 12px 24px 0px rgba(0, 0, 0, 0.20), 0px 6px 8px 0px rgba(0, 0, 0, 0.15), 0px 2px 3px 0px rgba(0, 0, 0, 0.10)'
} as const;

export type CumulusMode = 'OFF' | 'PV' | 'HC' | 'FORCE';

export function modeColor(mode: CumulusMode): string {
  switch (mode) {
    case 'PV':
      return colors.mode.pv;
    case 'HC':
      return colors.mode.hc;
    case 'FORCE':
      return colors.mode.force;
    default:
      return colors.mode.off;
  }
}
