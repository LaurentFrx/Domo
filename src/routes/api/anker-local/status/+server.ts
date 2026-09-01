/**
 * /api/anker-local/status — lecture LOCALE (Modbus TCP, lecture seule) des
 * devices Anker Solix, sans le cloud Solix ni sa latence ~60 s :
 *   - Solarbank Max AC (192.168.1.49:502) : SOC, flux batterie/AC, mode ;
 *   - Smart Meter Gen 2 (192.168.1.48:502) : puissance réseau signée.
 *
 * MÊME modèle que /api/em50/status : les devices ne sont JAMAIS exposés au
 * navigateur ni à Internet ; le client tape cette route (derrière le guard
 * d'auth de hooks.server.ts) et SvelteKit relaie server-to-server via la
 * loopback du VPS — sorties du tunnel SSH inverse 1502/1503 (cf. sur le RPi4
 * tunnel-1502-anker-modbus.sh + crontab @reboot, modèle tunnel-8102-em50.sh).
 * Le protocole Modbus (registres sourcés de l'intégration HA officielle
 * anker-charging/ha-anker-solix-official) vit dans $lib/server/anker-modbus.
 *
 * Un device injoignable ⇒ son bloc `available:false` dans un 200 (jamais de
 * 504 global : la Solarbank ne doit pas masquer le meter, et inversement).
 *
 * CONTRÔLE CROISÉ : le Gen 2 ne remplace PAS le EM-50 (source de vérité
 * réseau). On lit le EM-50 en best-effort à chaque poll, on expose l'écart
 * (grid_deviation_w) et on le journalise (throttlé) s'il dépasse le seuil —
 * une dérive durable = pince/CT ou compteur à re-vérifier.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { calibratedGridW } from '$lib/server/em50-grid';
import { readAnkerMeter, readAnkerSolarbank } from '$lib/server/anker-modbus';
import type { RequestHandler } from './$types';

/** Écart Gen 2 ↔ EM-50 au-delà duquel on journalise (W). */
const DEVIATION_WARN_W = 150;
/** Au plus un log d'écart par minute (le poll est à 10 s). */
const DEVIATION_LOG_THROTTLE_MS = 60_000;
let lastDeviationLog = 0;

const EM50_TIMEOUT_MS = 3_000;

/**
 * Réseau signé vu par le EM-50 (mêmes env que /api/em50/status), ou null si
 * indisponible — le contrôle croisé est best-effort et ne doit rien casser.
 */
async function em50GridW(): Promise<number | null> {
  const base = env.EM50_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/rpc/Shelly.GetStatus`, {
      signal: AbortSignal.timeout(EM50_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, { act_power?: number } | undefined>;
    const p = d[`em1:${Number(env.EM50_GRID_ID ?? 0)}`]?.act_power;
    return calibratedGridW(p);
  } catch {
    return null;
  }
}

export const GET: RequestHandler = async () => {
  const [solarbank, meter, em50W] = await Promise.all([
    readAnkerSolarbank(),
    readAnkerMeter(),
    em50GridW()
  ]);

  const deviation = meter.available && em50W !== null ? Math.abs(meter.grid_power_w - em50W) : null;
  if (deviation !== null && deviation > DEVIATION_WARN_W) {
    const now = Date.now();
    if (now - lastDeviationLog > DEVIATION_LOG_THROTTLE_MS) {
      lastDeviationLog = now;
      console.warn(
        `[anker-local] écart réseau Gen 2 ↔ EM-50 : ${deviation} W ` +
          `(Gen 2 ${meter.grid_power_w} W, EM-50 ${em50W} W)`
      );
    }
  }

  return json({
    solarbank,
    meter,
    /** Réseau signé vu par le EM-50 (contrôle croisé), null si indisponible. */
    em50_grid_w: em50W,
    /** |Gen 2 − EM-50| (W), null si l'un des deux manque. */
    grid_deviation_w: deviation,
    ts: Math.floor(Date.now() / 1000)
  });
};
