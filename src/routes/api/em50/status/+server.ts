/**
 * /api/em50/status — lecture du Shelly Pro EM-50 (compteur 2 voies : réseau EDF
 * + conso cumulus), via la loopback du VPS, sortie du tunnel SSH inverse
 * 127.0.0.1:8102 → EM50 192.168.1.54:80 (cf. sur le RPi4 tunnel-8102-em50.sh +
 * crontab @reboot). MÊME modèle que /api/cumulus/relay : le device n'est JAMAIS
 * exposé au navigateur ni à Internet ; le client tape /api/em50/status (derrière
 * le guard d'auth de hooks.server.ts) et SvelteKit relaie server-to-server, en
 * transformant le RPC Gen2 brut en JSON filtré (jamais le RPC nu).
 *
 * Un SEUL appel RPC (Shelly.GetStatus) → snapshot atomique des 2 voies + cumuls.
 *
 * Mapping des voies (EM1:0 / EM1:1) CONFIGURABLE par env : les voies ne sont pas
 * nommées dans l'app Shelly (`name:null`) → impossible d'auto-mapper par le nom ;
 * on fige donc le mapping en conf (déterminé à l'install par le signe : seule la
 * voie réseau peut être négative = injection PV).
 *   EM50_GRID_ID     (défaut 0) — voie compteur réseau EDF (act_power signé)
 *   EM50_CUMULUS_ID  (défaut 1) — voie conso chauffe-eau (charge pure, ≥ 0)
 *   EM50_GRID_SIGN   (défaut 1) — 1 ou -1 ; inverse le signe réseau si la pince
 *                                 est physiquement montée à l'envers (sans y
 *                                 retoucher).
 *
 * Convention de sortie : grid_power_w SIGNÉ → + soutirage EDF / − injection PV.
 * Énergies converties en kWh (Wh du device / 1000).
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const deviceUrl = () => {
  const u = env.EM50_URL;
  if (!u) throw error(503, 'EM50_URL non configurée');
  return u.replace(/\/+$/, '');
};

// Mapping + signe lus à chaque requête : édition du .env prise en compte sans
// rebuild (cohérent avec l'env dynamique de SvelteKit).
const gridId = () => Number(env.EM50_GRID_ID ?? 0);
const cumulusId = () => Number(env.EM50_CUMULUS_ID ?? 1);
const gridSign = () => (Number(env.EM50_GRID_SIGN ?? 1) < 0 ? -1 : 1);

const TIMEOUT_MS = 8_000;

interface Em1 {
  id: number;
  voltage?: number;
  current?: number;
  act_power?: number;
}
interface Em1Data {
  id: number;
  total_act_energy?: number;
  total_act_ret_energy?: number;
}

/** Garde : nombre fini, sinon 0 (jamais NaN/undefined dans le payload). */
function num(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export const GET: RequestHandler = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${deviceUrl()}/rpc/Shelly.GetStatus`, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'réseau';
    throw error(504, `Shelly EM50 injoignable (${reason}).`);
  }
  clearTimeout(timer);

  if (!upstream.ok) throw error(502, `Shelly EM50: HTTP ${upstream.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (await upstream.json().catch(() => null)) as Record<string, any> | null;
  if (d === null) throw error(502, 'Shelly EM50: JSON invalide');

  const gi = gridId();
  const ci = cumulusId();
  const sign = gridSign();

  const gEm = d[`em1:${gi}`] as Em1 | undefined;
  const gData = d[`em1data:${gi}`] as Em1Data | undefined;
  const cEm = d[`em1:${ci}`] as Em1 | undefined;
  const cData = d[`em1data:${ci}`] as Em1Data | undefined;

  // Voies attendues absentes → mapping/firmware inattendu : 502 explicite plutôt
  // qu'un payload silencieusement faux.
  if (!gEm || !cEm) throw error(502, `Shelly EM50: voies em1:${gi}/em1:${ci} absentes`);

  return json({
    available: true,
    // Réseau (signé) : + soutirage EDF / − injection PV.
    grid_power_w: Math.round(sign * num(gEm.act_power)),
    grid_voltage_v: num(gEm.voltage),
    grid_import_kwh: num(gData?.total_act_energy) / 1000,
    grid_export_kwh: num(gData?.total_act_ret_energy) / 1000,
    // Cumulus (charge pure, toujours ≥ 0).
    cumulus_power_w: Math.round(num(cEm.act_power)),
    cumulus_current_a: num(cEm.current),
    cumulus_kwh: num(cData?.total_act_energy) / 1000,
    // Horloge du device si dispo, sinon horloge serveur.
    ts: num(d?.sys?.unixtime) || Math.floor(Date.now() / 1000)
  });
};
