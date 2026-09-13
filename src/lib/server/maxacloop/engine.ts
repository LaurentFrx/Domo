/**
 * Moteur de la boucle de charge Max AC — lecture des entrées, écriture, état.
 *
 * La loi de commande vit dans `decide.ts` (pure, testée). Ici on ne fait que
 * l'entrée-sortie : rassembler des mesures FRAÎCHES, appliquer la décision sur
 * l'appareil, revendiquer le contrôle auprès du chien de garde, persister.
 *
 * ORDRE DES ÉCRITURES — il n'est pas arbitraire :
 *   · pour PRENDRE la barre : mode 3 d'abord, consigne AUSSITÔT après. Entre les
 *     deux l'appareil est inerte (il ne régule plus et n'a pas encore d'ordre) ;
 *     c'est la seule fenêtre dangereuse et elle dure ~5 s.
 *   · pour la RENDRE : consigne 0 d'abord, mode 0 ensuite. L'inverse laisserait
 *     une consigne active sur un appareil qui vient de reprendre sa régulation.
 *   · tout échec d'écriture → on rend la main et on oublie l'état de pilotage.
 *     Le mode sûr est celui où l'appareil se gouverne lui-même.
 */
import { env } from '$env/dynamic/private';
import { readAnkerSolarbank } from '$lib/server/anker-modbus';
import { calibratedGridW } from '$lib/server/em50-grid';
import {
  writeMaxAcMode,
  writeMaxAcSetpoint,
  MAXAC_MODE_SELF_CONSUMPTION,
  MAXAC_MODE_THIRD_PARTY
} from '$lib/server/anker-modbus';
import { claimMaxAcControl, releaseMaxAcControl } from '$lib/server/maxac-control';
import { readJsonSafe, writeJsonAtomic } from '$lib/server/atomic-store';
import { decideMaxAc } from './decide';
import {
  MAXAC_LOOP_DEFAULTS,
  emptyMaxAcState,
  type MaxAcLoopInputs,
  type MaxAcLoopState
} from './types';

import path from 'node:path';

const STATE_FILE = path.resolve(process.cwd(), 'data', 'maxacloop-state.json');
const MAX_LOG = 40;
/** Au-delà, le snapshot du pont Anker est trop vieux pour décider (cf. sb3loop). */
const CLOUD_STALE_S = 180;

/** Verrou de réentrance : un tick qui déborde ne doit pas en croiser un autre. */
let tickEnCours = false;

/** Interrupteur d'exploitation : la boucle ne fait RIEN tant qu'il n'est pas mis. */
function enabled(): boolean {
  return (env.MAXACLOOP_ENABLED ?? '').trim() === '1';
}

/** Observation : on décide et on journalise, mais on n'écrit pas sur l'appareil. */
function observationOnly(): boolean {
  return (env.MAXACLOOP_OBSERVE ?? '').trim() === '1';
}

async function loadState(): Promise<MaxAcLoopState> {
  return readJsonSafe(STATE_FILE, {
    fallback: emptyMaxAcState,
    normalize: (raw: unknown): MaxAcLoopState => ({ ...emptyMaxAcState(), ...(raw as object) }),
    label: 'maxacloop-state'
  });
}

/** Compteur EM-50 : mesure locale, instantanée, signée (+ import). */
async function readEm50(): Promise<{ ok: boolean; gridW: number; cumulusW: number | null }> {
  const base = (env.EM50_URL ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, gridW: 0, cumulusW: null };
  try {
    const [g, c] = await Promise.all([
      fetch(`${base}/rpc/EM1.GetStatus?id=0`, { signal: AbortSignal.timeout(4000) }),
      fetch(`${base}/rpc/EM1.GetStatus?id=1`, { signal: AbortSignal.timeout(4000) })
    ]);
    if (!g.ok) return { ok: false, gridW: 0, cumulusW: null };
    const gj = (await g.json()) as { act_power?: number };
    // ÉTALONNÉ, comme tout le reste du projet : la pince sous-lit de ~28 W et
    // viser le zéro BRUT reviendrait à acheter 28 W en permanence — c'est la
    // faute historique du 01/09 (« la boucle fabrique un achat EDF réel pour
    // corriger une injection imaginaire »). `null` = mesure inexploitable.
    const gridW = calibratedGridW(gj.act_power);
    if (gridW === null) return { ok: false, gridW: 0, cumulusW: null };
    const cj = c.ok ? ((await c.json()) as { act_power?: number }) : null;
    // Voie muette ⇒ `null`, JAMAIS 0 : un 0 dirait « pas de chauffe » et
    // éteindrait la garde en silence (leçon 21de23f).
    const cw = typeof cj?.act_power === 'number' ? Math.round(cj.act_power) : null;
    return { ok: true, gridW, cumulusW: cw };
  } catch {
    return { ok: false, gridW: 0, cumulusW: null };
  }
}

/** SoC et PV des SB3 + production APS, via le pont Anker (cloud, ~60 s). */
async function readParc(): Promise<{
  ok: boolean;
  sb3SocPct: number | null;
  sb3PvW: number;
  sb3OutW: number;
  apsW: number;
}> {
  const base = (env.ANKER_URL ?? '').replace(/\/+$/, '');
  const apsBase = (env.APSYSTEMS_BRIDGE_URL ?? '').replace(/\/+$/, '');
  let sb3SocPct: number | null = null;
  let sb3PvW = 0;
  let sb3OutW = 0;
  let ok = false;
  if (base) {
    try {
      const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const d = (await r.json()) as {
          batteries?: { soc?: number; model?: string }[];
          solar_power_w?: number;
          sb3_output_power_w?: number;
          connected?: boolean;
          last_update?: number;
        };
        // Un pont FIGÉ répond 200 avec des valeurs gelées : sans ces deux gardes
        // (reprises de sb3loop/inputs.ts) on piloterait sur un SoC de 100 % vieux
        // de vingt minutes alors que les packs sont à 60 %.
        const ageS =
          typeof d.last_update === 'number' ? Date.now() / 1000 - d.last_update : Infinity;
        const frais = d.connected !== false && ageS <= CLOUD_STALE_S;
        const socs = (d.batteries ?? [])
          .filter((b) => b.model === undefined || b.model === 'A17C5')
          .map((b) => b.soc)
          .filter((s): s is number => typeof s === 'number');
        if (frais && socs.length) {
          sb3SocPct = Math.min(...socs); // le maillon faible décide
          ok = true;
        }
        sb3PvW = Math.max(0, Math.round(d.solar_power_w ?? 0));
        sb3OutW = Math.max(0, Math.round(d.sb3_output_power_w ?? 0));
      }
    } catch {
      /* pont muet : ok reste false, la loi rendra la main */
    }
  }
  let apsW = 0;
  if (apsBase) {
    try {
      // ⚠️ Le chemin est `/api/apsystems/status` — `/api/status` renvoie 404, et
      // l'erreur était MUETTE : apsW restait à 0, la loi concluait « pas de
      // soleil » et la boucle ne démarrait jamais, sans une ligne de journal.
      const r = await fetch(`${apsBase}/api/apsystems/status`, {
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const d = (await r.json()) as { power_w?: number; p1_w?: number; p2_w?: number };
        apsW = Math.max(0, Math.round(d.power_w ?? (d.p1_w ?? 0) + (d.p2_w ?? 0)));
      }
    } catch {
      /* APS muet : la loi verra « pas de soleil » et rendra la main */
    }
  }
  return { ok, sb3SocPct, sb3PvW, sb3OutW, apsW };
}

export interface MaxAcTickResult {
  ok: boolean;
  enabled: boolean;
  observe: boolean;
  mode: string;
  reason: string;
  gridW: number | null;
  setpointW: number | null;
  writtenW: number | null;
  deviceMode: number | null;
}

export async function maxAcLoopTick(): Promise<MaxAcTickResult> {
  // Un tick qui déborde ne doit JAMAIS en croiser un autre : deux ticks
  // concurrents lisent le même état d'avant, décident séparément, et le dernier
  // qui écrit gagne — on peut finir avec un appareil en mode 3 que le fichier
  // déclare inactif, donc inerte et invisible. On SAUTE plutôt que de mettre en
  // file : une décision calculée sur des mesures de 20 s ne vaut plus rien.
  if (tickEnCours) {
    return {
      ok: true,
      enabled: true,
      observe: false,
      mode: 'skipped',
      reason: 'tick précédent encore en cours',
      gridW: null,
      setpointW: null,
      writtenW: null,
      deviceMode: null
    };
  }
  tickEnCours = true;
  try {
    return await tickInterne();
  } finally {
    tickEnCours = false;
  }
}

async function tickInterne(): Promise<MaxAcTickResult> {
  const now = Date.now();
  const state = await loadState();

  if (!enabled()) {
    // Interrupteur ouvert : si un tick précédent tenait la barre, on la rend —
    // on ne laisse jamais l'appareil en mode 3 derrière soi.
    if (state.setpointW !== null) {
      await writeMaxAcSetpoint(0);
      await writeMaxAcMode(MAXAC_MODE_SELF_CONSUMPTION);
      releaseMaxAcControl();
      await writeJsonAtomic(STATE_FILE, { ...emptyMaxAcState(), lastTickTs: now });
    }
    return {
      ok: true,
      enabled: false,
      observe: false,
      mode: 'idle',
      reason: 'boucle désactivée (MAXACLOOP_ENABLED)',
      gridW: null,
      setpointW: null,
      writtenW: null,
      deviceMode: null
    };
  }

  // UNE seule lecture Modbus : `readAnkerSolarbank` rapporte déjà le mode
  // (registre 10064) dans le même lot. Ouvrir une seconde socket en parallèle
  // sur un firmware mono-connexion faisait échouer l'une des deux au hasard.
  const [maxac, em50, parc] = await Promise.all([readAnkerSolarbank(), readEm50(), readParc()]);
  const deviceMode = maxac.available && maxac.mode_raw >= 0 ? maxac.mode_raw : null;

  const inputs: MaxAcLoopInputs = {
    now,
    gridW: em50.gridW,
    gridAvailable: em50.ok,
    maxAcBattW: maxac.available ? maxac.battery_power_w : 0,
    maxAcSocPct: maxac.available ? maxac.soc_pct : 0,
    maxAcAvailable: maxac.available,
    maxAcMode: deviceMode,
    sb3SocPct: parc.sb3SocPct,
    sb3Available: parc.ok,
    sb3PvW: parc.sb3PvW,
    sb3OutW: parc.sb3OutW,
    apsW: parc.apsW,
    cumulusW: em50.cumulusW
  };

  const d = decideMaxAc(inputs, MAXAC_LOOP_DEFAULTS, state);
  let writtenW: number | null = null;
  let next = d.nextState;

  if (!observationOnly()) {
    try {
      if (d.mode === 'enter') {
        // Revendiquer AVANT de basculer : la confirmation du mode prend jusqu'à
        // 8 s, pendant lesquelles l'appareil est déjà en mode 3. Sans cela le
        // chien de garde brûle deux de ses trois coups avant qu'on ait la barre.
        claimMaxAcControl(d.reason);
        // Consigne d'abord (sans effet tant que le mode est 0), mode ensuite :
        // l'ordre inverse laissait l'appareil en mode 3 avec la valeur de repos
        // du registre — c'est-à-dire 0 W, l'état inerte mesuré le 13/09.
        const okSp = await writeMaxAcSetpoint(d.writeW ?? 0);
        if (!okSp) throw new Error('consigne de continuité refusée');
        const okMode = await writeMaxAcMode(MAXAC_MODE_THIRD_PARTY);
        if (!okMode) throw new Error('bascule en mode 3 refusée');
        // Réécrite après la bascule : si l'appareil a ignoré la première (mode 0),
        // celle-ci prend, et si la première a pris, celle-ci est sans effet.
        await writeMaxAcSetpoint(d.writeW ?? 0);
        writtenW = d.writeW;
        claimMaxAcControl(d.reason);
      } else if (d.mode === 'adjust') {
        if (deviceMode !== MAXAC_MODE_THIRD_PARTY) throw new Error('mode 3 perdu sous nos pieds');
        const okSp = await writeMaxAcSetpoint(d.writeW ?? 0);
        if (!okSp) throw new Error('consigne refusée');
        writtenW = d.writeW;
        claimMaxAcControl(d.reason);
      } else if (d.mode === 'hold') {
        // Rien à écrire, mais il FAUT renouveler la revendication : le chien de
        // garde rendrait la main au bout de 30 s de silence. On ne la renouvelle
        // QUE si l'appareil est bien encore en mode 3 — mentir au seul organe
        // capable de rattraper serait le pire des choix.
        if (deviceMode === MAXAC_MODE_THIRD_PARTY) claimMaxAcControl(d.reason);
      } else if (d.mode === 'leave') {
        // Mode 0 D'ABORD : une consigne résiduelle sur un appareil qui régule est
        // inerte, alors qu'une consigne 0 sur un appareil en mode 3 est un ordre
        // ACTIF de ne rien absorber. On ne relâche la revendication qu'une fois
        // le mode 0 CONFIRMÉ, sinon le chien de garde perd 30 s à s'en apercevoir.
        const okMode = await writeMaxAcMode(MAXAC_MODE_SELF_CONSUMPTION);
        await writeMaxAcSetpoint(0);
        if (okMode) {
          releaseMaxAcControl();
        } else {
          console.error('[maxacloop] RETRAIT ÉCHOUÉ — appareil peut-être resté en mode 3');
          next = { ...next, setpointW: state.setpointW }; // on réessaiera au tick suivant
        }
        writtenW = 0;
      } else if (deviceMode === MAXAC_MODE_THIRD_PARTY) {
        // eslint-disable-next-line no-console
        // `idle` alors que l'appareil est resté en mode 3 (redémarrage de Domo,
        // état perdu) : on le ramène, sans quoi le chien de garde le fera.
        await writeMaxAcSetpoint(0);
        await writeMaxAcMode(MAXAC_MODE_SELF_CONSUMPTION);
        releaseMaxAcControl();
        writtenW = 0;
      }
    } catch (e) {
      // Tout échec d'écriture ramène au mode sûr, sans exception.
      console.error('[maxacloop] écriture en échec :', (e as Error).message);
      await writeMaxAcSetpoint(0).catch(() => {});
      await writeMaxAcMode(MAXAC_MODE_SELF_CONSUMPTION).catch(() => {});
      releaseMaxAcControl();
      // La MISE À L'ÉCART doit survivre au chemin d'erreur : l'effacer ferait
      // repartir la boucle au tick suivant sur la cause d'abandon inchangée.
      next = {
        ...emptyMaxAcState(),
        lastTickTs: now,
        penaltyUntilTs: Math.max(state.penaltyUntilTs, d.nextState.penaltyUntilTs),
        decisions: state.decisions
      };
    }
  }

  next.decisions = [
    ...(next.decisions ?? []),
    {
      ts: now,
      mode: d.mode,
      reason: d.reason,
      gridW: inputs.gridW,
      setpointW: next.setpointW,
      writtenW
    }
  ].slice(-MAX_LOG);
  await writeJsonAtomic(STATE_FILE, next);

  if (d.mode !== 'idle' && d.mode !== 'hold') {
    console.log(
      `[maxacloop] ${d.mode} | EDF=${inputs.gridW}W | MaxAC ${Math.round(inputs.maxAcSocPct)}% ` +
        `${Math.round(-inputs.maxAcBattW)}W charge | SB3 ${inputs.sb3SocPct}% PV ${inputs.sb3PvW}W — ${d.reason}`
    );
  }

  return {
    ok: true,
    enabled: true,
    observe: observationOnly(),
    mode: d.mode,
    reason: d.reason,
    gridW: inputs.gridW,
    setpointW: next.setpointW,
    writtenW,
    deviceMode
  };
}
