/**
 * Aperçu LED en TEMPS RÉEL — les vraies couleurs de chaque pixel du ruban.
 *
 * Demande Laurent (29/08) : « que les aperçus affichent les vraies couleurs de
 * chaque led individuellement, absolument identique aux leds en
 * fonctionnement ». Ce n'est plus une reconstitution (palette + effet devinés
 * côté client) mais LA sortie du firmware : c'est le même flux que le bouton
 * « Peek » de l'interface WLED native.
 *
 * Protocole (vérifié sur le module, firmware 16.0.1) : WebSocket `/ws`, on
 * envoie `{"lv":true}`, le module pousse des trames BINAIRES de
 * `2 + 3 × nbLED` octets — en-tête `'L'` + version, puis un triplet RGB par
 * LED, dans l'ordre physique du ruban. Mesuré : 308 octets pour 102 LED,
 * ~22 images/s. Le canal blanc est déjà fondu dans le RGB par le firmware.
 *
 * Coût maîtrisé : UNE SEULE connexion montante, partagée par tous les
 * navigateurs, ouverte seulement tant que quelqu'un regarde et fermée dès que
 * le dernier abonné part — l'ESP32 ne travaille jamais pour personne. Les
 * trames sont ré-échantillonnées à ~12 images/s vers les clients (l'œil n'y
 * voit rien, la bande passante est divisée par deux).
 */
import { env } from '$env/dynamic/private';

/** En-tête d'une trame live WLED : 'L' + version. */
const HDR = 2;
/** Cadence servie aux clients (le module pousse ~22 i/s). */
const MIN_FRAME_MS = 80;
/** Rallonge après une coupure, avant de retenter (ms). */
const RETRY_MS = 5_000;

type Frame = Uint8Array;
type Listener = (f: Frame) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = 0;
/** Dernière trame reçue — servie d'emblée à un nouvel abonné (pas d'écran vide). */
let lastFrame: Frame | null = null;

/** URL WebSocket du module, ou null (mock / non configuré). */
function wsUrl(): string | null {
  const u = (env.WLED_URL || '').trim().replace(/\/+$/, '');
  if (!u || u.toLowerCase() === 'mock') return null;
  return u.replace(/^http/i, 'ws') + '/ws';
}

/** L'aperçu temps réel est-il disponible sur cette installation ? */
export function liveLedsAvailable(): boolean {
  return wsUrl() !== null;
}

function connect(): void {
  if (socket || listeners.size === 0) return;
  const url = wsUrl();
  if (!url) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleRetry();
    return;
  }
  ws.binaryType = 'arraybuffer';
  socket = ws;

  ws.onopen = () => {
    // `lv` = live view : sans ce message, le module n'envoie que l'état JSON.
    try {
      ws.send(JSON.stringify({ lv: true }));
      console.log('[wled/leds] aperçu temps réel ouvert');
    } catch {
      /* socket refermée entre-temps */
    }
  };
  ws.onmessage = (ev) => {
    const data = ev.data;
    if (!(data instanceof ArrayBuffer)) return; // les trames JSON d'état ne nous concernent pas
    const buf = new Uint8Array(data);
    if (buf.length < HDR + 3 || buf[0] !== 0x4c) return; // 'L'
    lastFrame = buf;
    const now = Date.now();
    if (now - lastSent < MIN_FRAME_MS) return;
    lastSent = now;
    for (const fn of listeners) {
      try {
        fn(buf);
      } catch {
        /* abonné mort — retiré par son cancel() */
      }
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    console.log('[wled/leds] aperçu temps réel fermé');
    scheduleRetry();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* déjà fermée */
    }
  };
}

function scheduleRetry(): void {
  if (retryTimer || listeners.size === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, RETRY_MS);
  // Ne JAMAIS retenir le process à l'arrêt (leçon SIGTERM de domo.service).
  retryTimer.unref?.();
}

function disconnect(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const ws = socket;
  socket = null;
  lastFrame = null;
  if (!ws) return;
  try {
    // Couper la vue live avant de partir : le module cesse de produire.
    if (ws.readyState === 1) ws.send(JSON.stringify({ lv: false }));
    ws.close();
  } catch {
    /* déjà fermée */
  }
}

/**
 * S'abonne au flux de trames. Le premier abonné ouvre la connexion montante,
 * le dernier la referme. Rend la dernière trame connue tout de suite quand il
 * y en a une (l'aperçu s'allume sans attendre l'image suivante).
 */
export function subscribeLeds(fn: Listener): () => void {
  listeners.add(fn);
  connect();
  if (lastFrame) {
    try {
      fn(lastFrame);
    } catch {
      /* ignoré */
    }
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) disconnect();
  };
}
