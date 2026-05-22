/**
 * Design tokens Yeldra — version TypeScript.
 *
 * Source de vérité : `tokens.css` (CSS variables).
 * Ce fichier expose les valeurs pour usage en TS (logique conditionnelle,
 * computations dynamiques, charts qui ont besoin des couleurs en JS).
 */

export const colors = {
  primary: {
    100: '#E3DBFF',
    200: '#C6B5FF',
    300: '#A990FF',
    400: '#8D6CFF',
    500: '#6E45FF',
    600: '#5A35E0'
  },
  accent: {
    100: '#D9FEEB',
    200: '#B3FED7',
    300: '#8DFDC3',
    500: '#3DFD98',
    600: '#2DDD7E'
  },
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

export const radius = {
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  xl2: 24,
  pill: 9999
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
