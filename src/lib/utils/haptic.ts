/**
 * Haptic feedback cross-platform — Android + iOS 17.4+.
 *
 * - **Android** : `navigator.vibrate(ms)`.
 * - **iOS 17.4+** : hack DOM via `<input type="checkbox" switch>`. Apple émet un
 *   retour haptique natif quand ce contrôle bascule ; on bascule un switch
 *   masqué par programme depuis un geste utilisateur.
 *   ⚠️ Conditions pour que ça VIBRE réellement (sinon no-op invisible) :
 *     1. iOS ≥ 17.4 et Safari/WebKit (le `switch` n'existe pas avant).
 *     2. Réglages iOS → Sons et vibrations → **Vibrations système = activé**.
 *     3. Pas en mode économie d'énergie « extrême ».
 *   Le switch doit être RENDU (pas `display:none` ni `0×0`/`opacity:0`) : on le
 *   masque donc en sr-only (1px + clip), et on clique le `<label>` (pas l'input
 *   directement) — c'est la combinaison qui déclenche le haptique de façon fiable.
 * - **iOS < 17.4 / Safari desktop / Firefox** : no-op silencieux.
 *
 * Pas de dépendances, pas d'init. À appeler depuis n'importe quel handler de geste.
 */

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'success' | 'warning';

const VIBRATE_MS: Record<HapticStyle, number | number[]> = {
  light: 10,
  medium: 18,
  heavy: 32,
  success: [10, 30, 10],
  warning: [20, 40, 20]
};

let iosSwitchLabel: HTMLLabelElement | null = null;

/** Crée (une fois) un `<label><input switch></label>` masqué mais RENDU, et le
 *  renvoie. Cliquer le label bascule le switch → haptique iOS. */
function getIosSwitch(): HTMLLabelElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (iosSwitchLabel) return iosSwitchLabel;
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  // sr-only : hors écran mais TOUJOURS dans l'arbre de rendu (clé du haptique).
  label.style.cssText =
    'position:fixed;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;' +
    'clip:rect(0 0 0 0);white-space:nowrap;border:0;pointer-events:none;';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.appendChild(input);
  document.body.appendChild(label);
  iosSwitchLabel = label;
  return label;
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
    const label = getIosSwitch();
    if (!label) return;
    try {
      label.click();
      // Pour les patterns "success"/"warning"/"heavy" on déclenche plusieurs taps
      // espacés (single tap iOS = retour léger uniforme, on simule de l'intensité
      // par la répétition).
      if (style === 'medium' || style === 'success') {
        setTimeout(() => label.click(), 60);
      }
      if (style === 'heavy' || style === 'warning') {
        setTimeout(() => label.click(), 50);
        setTimeout(() => label.click(), 110);
      }
    } catch {
      // ignore
    }
    return;
  }

  // 'other' : desktop, no-op
}
