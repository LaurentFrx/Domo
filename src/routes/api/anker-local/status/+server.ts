/**
 * /api/anker-local/status — lecture LOCALE (Modbus TCP, lecture seule) du
 * Smart Meter Gen 2 (192.168.1.48:502) : puissance réseau signée, sans le cloud
 * Solix ni sa latence ~60 s.
 *
 * La Solarbank Max AC (192.168.1.49:502, tunnel 1503) a été retirée de
 * l'installation le 09/08/2026 — elle n'est plus lue. ⚠️ Elle répondait encore
 * en Modbus après son débranchement (batterie interne + Wi-Fi actif) : la
 * garder aurait injecté 7,1 kWh de batterie INERTE dans le SoC du parc, sans
 * qu'aucun fail-safe ne s'en aperçoive.
 *
 * MÊME modèle que /api/em50/status : les devices ne sont JAMAIS exposés au
 * navigateur ni à Internet ; le client tape cette route (derrière le guard
 * d'auth de hooks.server.ts) et SvelteKit relaie server-to-server via la
 * loopback du VPS — sortie du tunnel SSH inverse 1502 (cf. sur le RPi4
 * tunnel-1502-anker-modbus.sh + crontab @reboot, modèle tunnel-8102-em50.sh).
 * Le protocole Modbus (registres sourcés de l'intégration HA officielle
 * anker-charging/ha-anker-solix-official) vit dans $lib/server/anker-modbus.
 *
 * Device injoignable ⇒ `available:false` dans un 200 (jamais de 504).
 *
 * CONTRÔLE CROISÉ : le Gen 2 ne remplace PAS le EM-50 (source de vérité
 * réseau). On lit le EM-50 en best-effort à chaque poll, on expose l'écart
 * (grid_deviation_w) et on le journalise (throttlé) s'il dépasse le seuil —
 * une dérive durable = pince/CT ou compteur à re-vérifier.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { readAnkerMeter } from '$lib/server/anker-modbus';
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
    const sign = Number(env.EM50_GRID_SIGN ?? 1) < 0 ? -1 : 1;
    const p = d[`em1:${Number(env.EM50_GRID_ID ?? 0)}`]?.act_power;
    return typeof p === 'number' && Number.isFinite(p) ? Math.round(sign * p) : null;
  } catch {
    return null;
  }
}

export const GET: RequestHandler = async () => {
  const [meter, em50W] = await Promise.all([readAnkerMeter(), em50GridW()]);

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
    meter,
    /** Réseau signé vu par le EM-50 (contrôle croisé), null si indisponible. */
    em50_grid_w: em50W,
    /** |Gen 2 − EM-50| (W), null si l'un des deux manque. */
    grid_deviation_w: deviation,
    ts: Math.floor(Date.now() / 1000)
  });
};
