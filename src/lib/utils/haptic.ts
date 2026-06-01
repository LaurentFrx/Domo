/**
 * Haptic feedback cross-platform — Android + iOS 18+.
 *
 * - **Android** : `navigator.vibrate(ms)`.
 * - **iOS 18+** : hack DOM via `<input type="checkbox" switch>` (Apple a
 *   ajouté le retour haptique natif sur cet élément spécifique en iOS 18 ;
 *   tap programmatique → vibration courte).
 * - **iOS < 18 / Safari desktop / Firefox** : no-op silencieux.
 *
 * Pas de dépendances, pas d'init. À appeler depuis n'importe quel
 * handler de clic.
 */

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'success' | 'warning';

const VIBRATE_MS: Record<HapticStyle, number | number[]> = {
  light: 10,
  medium: 18,
  heavy: 32,
  success: [10, 30, 10],
  warning: [20, 40, 20]
};

let iosSwitchInput: HTMLInputElement | null = null;

function getIosSwitch(): HTMLInputElement | null {
  if (typeof document === 'undefined') return null;
  if (iosSwitchInput) return iosSwitchInput;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  input.style.width = '0';
  input.style.height = '0';
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  document.body.appendChild(input);
  iosSwitchInput = input;
  return input;
}

let cachedPlatform: 'ios' | 'android' | 'other' | null = null;
function detectPlatform(): 'ios' | 'android' | 'other' {
  if (cachedPlatform) return cachedPlatform;
  if (typeof navigator === 'undefined') {
    cachedPlatform = 'other';
    return cachedPlatform;
  }
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) cachedPlatform = 'ios';
  else if (/Android/.test(ua)) cachedPlatform = 'android';
  else cachedPlatform = 'other';
  return cachedPlatform;
}

/**
 * Déclenche un retour haptique.
 * @param style intensité/pattern parmi 'light' | 'medium' | 'heavy' | 'success' | 'warning'
 */
// Anti-double-buzz : un même geste peut déclencher haptic() deux fois (handler
// explicite d'un bouton + écouteur global délégué, cf. +layout.svelte). On
// coalesce les appels très rapprochés en un seul — la 1re intensité demandée
// gagne (souvent la plus spécifique, ex. 'medium' sur on/off vs 'light' global).
let lastHapticAt = 0;
const HAPTIC_DEDUPE_MS = 80;

export function haptic(style: HapticStyle = 'light'): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastHapticAt < HAPTIC_DEDUPE_MS) return;
  lastHapticAt = now;
  const platform = detectPlatform();

  if (platform === 'android') {
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate(VIBRATE_MS[style]);
      } catch {
        // ignore (mode policy interdit le vibrate)
      }
    }
    return;
  }

  if (platform === 'ios') {
    const input = getIosSwitch();
    if (!input) return;
    try {
      input.click();
      // Pour les patterns "success"/"warning"/"heavy" on déclenche plusieurs taps
      // espacés (single tap iOS = retour léger uniforme, on simule de l'intensité
      // par la répétition).
      if (style === 'medium' || style === 'success') {
        setTimeout(() => input.click(), 60);
      }
      if (style === 'heavy' || style === 'warning') {
        setTimeout(() => input.click(), 50);
        setTimeout(() => input.click(), 110);
      }
    } catch {
      // ignore
    }
    return;
  }

  // 'other' : desktop, no-op
}
