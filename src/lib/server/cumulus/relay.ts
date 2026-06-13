/**
 * Pilotage du relais cumulus (Shelly Pro 1, RPC Gen2) côté moteur.
 *
 * Distinct de la route /api/cumulus/relay (interface manuelle) : le moteur a
 * besoin du paramètre `toggle_after` de Switch.Set — le **watchdog matériel**.
 * Chaque ordre ON est émis avec `toggle_after = autoOffDelaySec` : si le moteur
 * cesse de ré-armer (crash Domo, tick mort), le Shelly repasse OFF tout seul au
 * bout du délai. Le ré-armement se fait naturellement à chaque tick (60 s ≪ délai).
 */

import { env } from '$env/dynamic/private';

const url = () => (env.SHELLY_CUMULUS_URL || 'http://127.0.0.1:8099').replace(/\/+$/, '');
const TIMEOUT_MS = 8_000;

export interface RelayRead {
  /** Le Shelly a répondu ? */
  available: boolean;
  /** État réel du relais (output), ou null si inconnu. */
  on: boolean | null;
  /** Température interne du boîtier (°C), diagnostic. */
  tC: number | null;
}

/** Lecture de l'état du relais (Switch.GetStatus). Ne lève jamais. */
export async function readRelay(): Promise<RelayRead> {
  try {
    const r = await fetch(`${url()}/rpc/Switch.GetStatus?id=0`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return { available: false, on: null, tC: null };
    const d = (await r.json()) as { output?: unknown; temperature?: { tC?: unknown } };
    return {
      available: true,
      on: typeof d.output === 'boolean' ? d.output : null,
      tC: typeof d.temperature?.tC === 'number' ? d.temperature.tC : null
    };
  } catch {
    return { available: false, on: null, tC: null };
  }
}

/**
 * Applique un ordre relais. Pour ON, arme `toggle_after` (watchdog auto-off).
 * Relit l'état réel après coup (le Shelly est en mode « follow » : la vérité du
 * boîtier prime). Ne lève jamais — renvoie `ok:false` en cas d'échec réseau.
 */
export async function setRelay(
  on: boolean,
  toggleAfterSec?: number
): Promise<{ ok: boolean; on: boolean | null }> {
  const q = new URLSearchParams({ id: '0', on: String(on) });
  if (on && toggleAfterSec && toggleAfterSec > 0) {
    q.set('toggle_after', String(Math.round(toggleAfterSec)));
  }
  try {
    const r = await fetch(`${url()}/rpc/Switch.Set?${q.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!r.ok) return { ok: false, on: null };
    const after = await readRelay();
    return { ok: true, on: after.on };
  } catch {
    return { ok: false, on: null };
  }
}
