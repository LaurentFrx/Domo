/**
 * Proxy serveur vers l'imprimante Epson Workforce (LAN via Tailscale).
 *
 * Configuration .env :
 *   PRINTER_HOST=192.168.1.40    ← IP locale de l'imprimante
 *   PRINTER_TIMEOUT_MS=5000      ← timeout HTTP (optionnel)
 *
 * Format Epson moderne (ET-… / WF-…) :
 *   - HTTP redirige vers HTTPS avec certificat self-signed
 *   - Page PRTINFO.HTML contient 4 <img height='X' style=''> qui
 *     représentent les barres d'encre dans l'ordre standard CMYK :
 *     Black (BK), Cyan (C), Magenta (M), Yellow (Y).
 *   - X est la hauteur en pixels (0–50). 50 = plein, 0 = vide.
 */

import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import https from 'node:https';
import http from 'node:http';
import type { RequestHandler } from './$types';

const DEFAULT_TIMEOUT_MS = 5000;
const FULL_HEIGHT_PX = 50;

export interface InkTank {
  color: 'BK' | 'C' | 'M' | 'Y';
  label: string;
  percent: number;
}

export interface PrinterStatus {
  fetchedAt: string;
  online: boolean;
  inks: InkTank[];
}

/**
 * GET HTTP/HTTPS avec suivi des redirects et acceptation des certs
 * self-signed. node:https natif → pas de dépendance externe.
 */
function getUrl(url: string, timeoutMs: number, maxRedirects = 5): Promise<string> {
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
        // Suivi des redirects 301/302/303/307/308
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          if (maxRedirects <= 0) {
            reject(new Error('Trop de redirects'));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          getUrl(next, timeoutMs, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (code !== 200) {
          reject(new Error(`HTTP ${code} sur ${url}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout ${timeoutMs}ms`)));
    req.end();
  });
}

async function fetchEpsonHtml(host: string, timeoutMs: number): Promise<string> {
  return getUrl(`http://${host}/PRESENTATION/HTML/TOP/PRTINFO.HTML`, timeoutMs);
}

/**
 * Capture les 4 barres d'encre. Le critère : <img ... height='X' ... style='...'>
 * où style est vide ou ne contient pas explicitement de hauteur (filtre les
 * éléments décoratifs comme le logo EPSON qui n'ont pas style=).
 */
function parseInkHeights(html: string): number[] {
  // Matche tout <img> qui a height='X' ET style='' ou style=""
  const re = /<img[^>]*\bheight\s*=\s*['"]?(\d+)['"]?[^>]*\bstyle\s*=\s*['"][\s]*['"][^>]*>/gi;
  const heights: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const h = parseInt(m[1], 10);
    if (h >= 0 && h <= FULL_HEIGHT_PX) {
      heights.push(h);
      if (heights.length === 4) break;
    }
  }
  return heights;
}

function heightToPercent(h: number): number {
  return Math.round((h / FULL_HEIGHT_PX) * 100);
}

const COLOR_LABELS: Record<InkTank['color'], string> = {
  BK: 'Noir',
  C: 'Cyan',
  M: 'Magenta',
  Y: 'Jaune'
};

export const GET: RequestHandler = async () => {
  const host = env.PRINTER_HOST;
  if (!host) {
    throw error(503, "PRINTER_HOST non défini dans .env — l'endpoint reste désactivé.");
  }
  const timeoutMs = Number(env.PRINTER_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  let html: string;
  try {
    html = await fetchEpsonHtml(host, timeoutMs);
  } catch (e) {
    return json(
      {
        fetchedAt: new Date().toISOString(),
        online: false,
        inks: [],
        error: (e as Error).message
      } satisfies PrinterStatus & { error: string },
      { status: 200 }
    );
  }

  const heights = parseInkHeights(html);
  if (heights.length < 4) {
    return json(
      {
        fetchedAt: new Date().toISOString(),
        online: true,
        inks: [],
        error: `Parsing : seulement ${heights.length} barres trouvées (attendu 4). Le HTML d'Epson a peut-être changé de format.`
      } satisfies PrinterStatus & { error: string },
      { status: 200 }
    );
  }

  const colors: InkTank['color'][] = ['BK', 'C', 'M', 'Y'];
  const inks: InkTank[] = heights.slice(0, 4).map((h, i) => ({
    color: colors[i],
    label: COLOR_LABELS[colors[i]],
    percent: heightToPercent(h)
  }));

  const payload: PrinterStatus = {
    fetchedAt: new Date().toISOString(),
    online: true,
    inks
  };
  return json(payload);
};
