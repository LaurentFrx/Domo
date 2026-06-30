/**
 * Proxy serveur vers l'imprimante Epson Workforce / EcoTank (LAN via Tailscale).
 *
 * Configuration .env :
 *   PRINTER_HOST=192.168.1.19    ← IP locale PRÉFÉRÉE de l'imprimante
 *   PRINTER_TIMEOUT_MS=5000      ← timeout HTTP (optionnel)
 *   PRINTER_SUBNET=192.168.1     ← /24 à balayer en redécouverte (optionnel ;
 *                                   déduit de PRINTER_HOST si c'est une IPv4)
 *   PRINTER_DISCOVERY=off        ← désactive la redécouverte auto (optionnel)
 *
 * Format Epson moderne (ET-… / WF-…) :
 *   - HTTP redirige vers HTTPS avec certificat self-signed.
 *   - Page PRTINFO.HTML contient 4 <img src='…Ink_X.PNG' height='N' style=''>
 *     où X ∈ {K,C,M,Y} (Noir, Cyan, Magenta, Jaune) et N = hauteur en pixels
 *     (0–50 ; 50 = plein, 0 = vide). ⚠ L'ORDRE des barres dépend du modèle
 *     (l'ET-2870 sort K,Y,M,C) : on lit donc la couleur dans `src`, JAMAIS par
 *     position, sinon Cyan et Jaune s'intervertissent.
 *
 * Résilience (anti « IP qui dérive ») : si PRINTER_HOST ne répond plus, on
 * balaie le /24 à la recherche de la signature Epson (≥3 barres d'encre) et on
 * bascule automatiquement sur l'IP trouvée. Le bail DHCP peut donc bouger sans
 * que la carte ne tombe en panne (correctif racine, optionnel : réserver l'IP
 * de l'imprimante par sa MAC dans la Livebox).
 */

import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import type { RequestHandler } from './$types';

const DEFAULT_TIMEOUT_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 1500; // par hôte pendant le balayage — court
const TCP_PROBE_TIMEOUT_MS = 1000;
const FULL_HEIGHT_PX = 50;
const SCAN_CONCURRENCY = 48; // sondes TCP simultanées sur le /24
const HTTP_PROBE_CONCURRENCY = 8;
const DISCOVERY_MIN_INTERVAL_MS = 5 * 60 * 1000; // ne pas re-scanner à chaque échec
const MAX_BODY_BYTES = 4 * 1024 * 1024; // garde-fou OOM (page Epson ≈ 50 Ko)

export interface InkTank {
  color: 'BK' | 'C' | 'M' | 'Y';
  label: string;
  percent: number;
}

export interface PrinterStatus {
  fetchedAt: string;
  online: boolean;
  inks: InkTank[];
  /** IP effectivement interrogée (peut différer de PRINTER_HOST si redécouverte). */
  host?: string;
  /** true si l'imprimante a été retrouvée à une autre IP que celle configurée. */
  relocated?: boolean;
  error?: string;
}

/**
 * GET HTTP/HTTPS avec suivi des redirects et acceptation des certs
 * self-signed. node:https natif → pas de dépendance externe.
 */
function getUrl(url: string, timeoutMs: number, maxRedirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
        rejectUnauthorized: false, // certificat self-signed de l'Epson
        headers: { 'User-Agent': 'Domo/1.0' }
      },
      (res) => {
        const code = res.statusCode ?? 0;
        // Suivi des redirects 301/302/303/307/308, mais UNIQUEMENT vers le même
        // hôte (l'Epson redirige http→https sur sa propre IP). Refuser un saut
        // cross-host ferme la porte au SSRF (loopback, link-local, métadonnées…).
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.destroy();
          if (maxRedirects <= 0) {
            reject(new Error('Trop de redirects'));
            return;
          }
          const next = new URL(res.headers.location, url);
          if (next.hostname !== u.hostname) {
            reject(new Error(`Redirect cross-host refusé → ${next.hostname}`));
            return;
          }
          getUrl(next.toString(), timeoutMs, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (code !== 200) {
          res.destroy();
          reject(new Error(`HTTP ${code} sur ${url}`));
          return;
        }
        // Borne la taille accumulée → pas d'OOM si un hôte hostile streame sans fin.
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_BODY_BYTES) {
            req.destroy(new Error('Réponse trop volumineuse'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout ${timeoutMs}ms`)));
    req.end();
  });
}

function fetchEpsonHtml(host: string, timeoutMs: number): Promise<string> {
  return getUrl(`http://${host}/PRESENTATION/HTML/TOP/PRTINFO.HTML`, timeoutMs);
}

const COLOR_LABELS: Record<InkTank['color'], string> = {
  BK: 'Noir',
  C: 'Cyan',
  M: 'Magenta',
  Y: 'Jaune'
};
/** Lettre Epson (dans `Ink_X.PNG`) → couleur interne. */
const LETTER_TO_COLOR: Record<string, InkTank['color']> = {
  K: 'BK',
  C: 'C',
  M: 'M',
  Y: 'Y'
};
/** Ordre d'affichage canonique CMYK, indépendant de l'ordre du HTML. */
const DISPLAY_ORDER: InkTank['color'][] = ['BK', 'C', 'M', 'Y'];

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=\s*['"]([^'"]*)['"]/i;
const HEIGHT_ATTR_RE = /\bheight\s*=\s*['"]?(\d+)['"]?/i;
const INK_SRC_RE = /Ink_([KCMY])\.png/i;

function heightToPercent(h: number): number {
  return Math.round((h / FULL_HEIGHT_PX) * 100);
}

/**
 * Lit les barres d'encre par COULEUR (depuis `src='…Ink_X.PNG'`), pas par
 * position — robuste à l'ordre des barres, qui varie selon le modèle Epson.
 * Renvoie les cuves dans l'ordre d'affichage canonique BK, C, M, Y.
 */
function parseInkTanks(html: string): InkTank[] {
  const byColor = new Map<InkTank['color'], number>();
  for (const m of html.matchAll(IMG_TAG_RE)) {
    const tag = m[0];
    const src = SRC_ATTR_RE.exec(tag)?.[1];
    if (!src) continue;
    const ink = INK_SRC_RE.exec(src);
    if (!ink) continue;
    const color = LETTER_TO_COLOR[ink[1].toUpperCase()];
    if (!color || byColor.has(color)) continue;
    const hm = HEIGHT_ATTR_RE.exec(tag);
    if (!hm) continue;
    const h = parseInt(hm[1], 10);
    if (h >= 0 && h <= FULL_HEIGHT_PX) byColor.set(color, h);
  }
  return DISPLAY_ORDER.filter((c) => byColor.has(c)).map((c) => ({
    color: c,
    label: COLOR_LABELS[c],
    percent: heightToPercent(byColor.get(c)!)
  }));
}

// ─── Redécouverte automatique de l'imprimante sur le LAN ────────────────────
// Mémoire de process : si l'IP a dérivé, on retient la nouvelle pour les requêtes
// suivantes (la config .env reste la valeur préférée, retentée en premier).
let discoveredHost: string | null = null;
let lastDiscoveryAt = 0;
let discovering = false; // single-flight : un seul scan à la fois

/** /24 à balayer : PRINTER_SUBNET sinon les 3 premiers octets d'une IPv4. */
function subnetBase(hint: string | undefined): string | null {
  const explicit = env.PRINTER_SUBNET?.trim();
  if (explicit) return explicit.replace(/\.+$/, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(hint ?? '');
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Connexion TCP brève — true si le port accepte (pré-filtre rapide du scan). */
function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * L'hôte est-il bien l'imprimante Epson ? Double critère pour éviter qu'un autre
 * serveur du LAN servant par hasard des images `Ink_*.PNG` soit pris pour elle :
 * marqueur « EPSON » dans la page ET au moins 3 barres d'encre reconnues.
 */
async function looksLikeEpson(host: string): Promise<boolean> {
  try {
    const html = await fetchEpsonHtml(host, DISCOVERY_TIMEOUT_MS);
    return /epson/i.test(html) && parseInkTanks(html).length >= 3;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

/**
 * Balaie le /24 : phase 1 = sonde TCP:80 (rapide), phase 2 = signature Epson
 * sur les hôtes ouverts. Renvoie la 1ʳᵉ IP qui ressemble à l'imprimante.
 */
async function discoverPrinter(hint: string | undefined): Promise<string | null> {
  if (env.PRINTER_DISCOVERY === 'off') return null;
  const base = subnetBase(hint);
  if (!base) return null;

  const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
  const openProbes = await mapWithConcurrency(ips, SCAN_CONCURRENCY, (ip) =>
    tcpOpen(ip, 80, TCP_PROBE_TIMEOUT_MS).then((ok) => (ok ? ip : null))
  );
  const open = openProbes.filter((ip): ip is string => ip !== null);

  // Sonde la signature Epson par petits paquets ; sort à la 1ʳᵉ correspondance.
  for (let i = 0; i < open.length; i += HTTP_PROBE_CONCURRENCY) {
    const batch = open.slice(i, i + HTTP_PROBE_CONCURRENCY);
    const hits = await Promise.all(
      batch.map((ip) => looksLikeEpson(ip).then((ok) => (ok ? ip : null)))
    );
    const found = hits.find((ip): ip is string => ip !== null);
    if (found) return found;
  }
  return null;
}

async function tryFetch(
  host: string,
  timeoutMs: number
): Promise<{ html?: string; error?: string }> {
  try {
    return { html: await fetchEpsonHtml(host, timeoutMs) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Déclenche une redécouverte EN ARRIÈRE-PLAN — ne bloque JAMAIS la réponse HTTP.
 * `discovering` (single-flight) + débounce évitent les scans parallèles ou trop
 * fréquents. Le résultat est mémorisé dans `discoveredHost` et profite à la
 * requête suivante (le store re-poll en 30 s sur erreur).
 */
function maybeTriggerDiscovery(hint: string): void {
  if (env.PRINTER_DISCOVERY === 'off') return;
  const now = Date.now();
  if (discovering || now - lastDiscoveryAt < DISCOVERY_MIN_INTERVAL_MS) return;
  discovering = true;
  lastDiscoveryAt = now;
  void discoverPrinter(hint)
    .then((found) => {
      if (found && found !== discoveredHost) {
        if (found !== env.PRINTER_HOST) console.warn(`[printer] redécouverte → ${found}`);
        discoveredHost = found;
      }
    })
    .catch((e) => console.error('[printer] redécouverte', (e as Error).message))
    .finally(() => {
      discovering = false;
    });
}

export const GET: RequestHandler = async () => {
  const configured = env.PRINTER_HOST;
  if (!configured) {
    throw error(503, "PRINTER_HOST non défini dans .env — l'endpoint reste désactivé.");
  }
  const timeoutMs = Number(env.PRINTER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  // Hôte courant = IP redécouverte si on en a une, sinon la config.
  const host = discoveredHost ?? configured;
  const relocated = host !== configured;
  const attempt = await tryFetch(host, timeoutMs);

  // Échec → on lance une redécouverte EN FOND et on répond tout de suite avec
  // l'état connu ; la prochaine requête bénéficiera de la nouvelle IP.
  if (!attempt.html) {
    maybeTriggerDiscovery(host);
  }

  const fetchedAt = new Date().toISOString();

  if (!attempt.html) {
    return json(
      {
        fetchedAt,
        online: false,
        inks: [],
        host,
        relocated,
        error: attempt.error
      } satisfies PrinterStatus,
      { status: 200 }
    );
  }

  const inks = parseInkTanks(attempt.html);
  if (inks.length < 4) {
    return json(
      {
        fetchedAt,
        online: true,
        inks,
        host,
        relocated,
        error: `Parsing : seulement ${inks.length} barre(s) trouvée(s) (attendu 4). Le HTML d'Epson a peut-être changé de format.`
      } satisfies PrinterStatus,
      { status: 200 }
    );
  }

  return json({ fetchedAt, online: true, inks, host, relocated } satisfies PrinterStatus);
};
