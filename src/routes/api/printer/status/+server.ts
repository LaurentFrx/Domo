/**
 * Proxy serveur vers l'imprimante Epson Workforce (LAN).
 *
 * Pourquoi un proxy : le navigateur ne peut pas tapper sur l'IP LAN
 * (CORS + mixed content HTTPS→HTTP). On scrape côté Node, on parse
 * et on expose un JSON normalisé.
 *
 * Configuration .env :
 *   PRINTER_HOST=192.168.X.X     ← IP locale de l'imprimante
 *   PRINTER_TIMEOUT_MS=5000      ← timeout HTTP (optionnel)
 *
 * Heuristique de parsing : la page PRTINFO.HTML d'Epson Workforce
 * contient 4 images <IMG ... height="X" alt=""> où X est la hauteur
 * en pixels de la barre d'encre (0 = vide, ~50 = plein). On extrait
 * dans l'ordre BK, C, M, Y et on normalise en pourcentage.
 */

import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const DEFAULT_TIMEOUT_MS = 5000;
const FULL_HEIGHT_PX = 50; // hauteur d'une barre pleine sur la page Epson

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

async function fetchEpsonHtml(host: string, timeoutMs: number): Promise<string> {
  const url = `http://${host}/PRESENTATION/HTML/TOP/PRTINFO.HTML`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Domo/1.0' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

/**
 * Cherche les 4 <img height="N" ...> qui représentent les niveaux d'encre.
 * Plusieurs variantes Epson : on prend les 4 premiers <img> avec un height
 * compris dans [0, FULL_HEIGHT_PX].
 */
function parseInkHeights(html: string): number[] {
  const re = /<img[^>]*height\s*=\s*["']?(\d+)["']?[^>]*>/gi;
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
    throw error(503, "PRINTER_HOST non défini dans .env — l'endpoint /api/printer/status reste désactivé jusqu'à configuration.");
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
