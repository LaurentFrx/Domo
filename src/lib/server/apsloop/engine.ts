/**
 * Moteur de la boucle de bridage APS — tick impur (lecture, décision, écriture).
 *
 * Sécurités structurelles :
 *  - DÉSACTIVÉE par défaut, et en OBSERVATION à la première activation : elle
 *    journalise le plafond qu'elle AURAIT écrit sans rien commander. Passage au
 *    réel explicite.
 *  - à l'arrêt (désactivation) elle REND le plafond au maximum : jamais d'onduleur
 *    laissé bridé par une boucle qui ne tourne plus.
 *  - deux échecs d'écriture consécutifs → auto-désactivation + restauration.
 *  - toute la logique de décision est dans decide.ts (pure, testée).
 *
 * CONSIGNE PERMANENTE : aucune réinjection sur le réseau. Ce garde-fou n'a donc
 * pas le droit de s'éteindre définitivement — trois défauts constatés le
 * 29/08/2026, après 17 jours d'injection non bridée :
 *  1. l'onduleur EZ1 s'éteint la nuit ; le renouvellement du bail partait quand
 *     même, ne recevait pas de confirmation et comptait un échec. ENDORMI ≠
 *     REFUS : on n'écrit plus quand le pont annonce l'onduleur indisponible
 *     (même famille de piège que « bornée ≠ refusée » sur la boucle SB3).
 *  2. un arrêt de sécurité était DÉFINITIF — la protection est restée éteinte du
 *     12/08 21h23 au 29/08, sans que rien ne la rallume. Elle se réarme
 *     maintenant d'elle-même dès que l'onduleur est de nouveau joignable ET
 *     producteur, avec un quota journalier pour ne pas boucler sur une panne.
 *  3. le réarmement forçait le mode OBSERVATION : la protection revenait, mais
 *     ne commandait plus rien. Une protection qui regarde ne protège pas.
 *  4. et rien n'était notifié (contrairement à la boucle SB3).
 */
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { calibratedGridW } from '$lib/server/em50-grid';
import { readJsonSafe, writeJsonAtomic, withFileLock } from '$lib/server/atomic-store';
import { decideAps, shouldRearmAps } from './decide';
import { sendPush } from '$lib/server/monitor/push';
import {
  defaultApsLoopConfig,
  defaultApsLoopState,
  type ApsLoopInputs,
  type ApsLoopState
} from './types';

const STATE_FILE = path.join(path.resolve(process.cwd(), 'data'), 'apsloop-state.json');
const BRIDGE = () => (env.APSYSTEMS_BRIDGE_URL || 'http://127.0.0.1:8100').replace(/\/+$/, '');
const EM50 = () => (env.EM50_URL || 'http://127.0.0.1:8102').replace(/\/+$/, '');
const TOKEN = () => env.APS_WRITE_TOKEN || '';
const TIMEOUT = 8_000;
const LOG_MAX = 40;
const CONFIRM_FAIL_MAX = 2;
/** Période de renouvellement du bail de plafond (bail du pont : 600 s). */
const KEEPALIVE_MS = 120_000;
/** Délai minimal avant qu'un arrêt de sécurité se réarme tout seul. */
const REARM_DELAY_MS = 15 * 60_000;
/** Réarmements automatiques autorisés par journée (Paris). Au-delà, la panne
 *  est réelle et durable : on cesse d'insister, mais on le DIT. */
const REARM_MAX_PER_DAY = 4;

const PARIS_DAY_FMT = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' });
const parisDay = (ts: number) => PARIS_DAY_FMT.format(new Date(ts));

export interface ApsLogEntry {
  ts: number;
  mode: string;
  writtenW: number | null;
  confirmedW: number | null;
  gridW: number;
  apsW: number;
  maxW: number;
  reason: string;
}

/**
 * Photo du dernier tick. La carte lit ÇA plutôt que d'interroger le pont
 * elle-même : une donnée vieille de 30 s suffit largement pour une boucle qui
 * décide en minutes, et ça évite d'ajouter un appel réseau faillible à un
 * endpoint qui doit rester lisible même quand le matériel est muet.
 */
export interface ApsObservation {
  ts: number;
  gridW: number;
  apsW: number;
  capW: number;
  maxLimitW: number;
  apsAvailable: boolean;
  em50Available: boolean;
}

export interface ApsLoopStore {
  enabled: boolean;
  /** true = journalise sans écrire (banc d'observation). */
  observationMode: boolean;
  lastObs: ApsObservation | null;
  autoDisabledReason: string | null;
  /** Quand la sécurité a coupé — sert à dater le réarmement automatique. */
  autoDisabledTs: number | null;
  /** Journée (Paris) du dernier réarmement automatique, et compteur du jour. */
  rearmDayParis: string | null;
  rearmCount: number;
  confirmFailCount: number;
  lastTickTs: number | null;
  lastWriteTs: number | null;
  lastCmdW: number | null;
  loop: ApsLoopState;
  log: ApsLogEntry[];
}

function defaultStore(): ApsLoopStore {
  return {
    enabled: false,
    observationMode: true,
    lastObs: null,
    autoDisabledReason: null,
    autoDisabledTs: null,
    rearmDayParis: null,
    rearmCount: 0,
    confirmFailCount: 0,
    lastTickTs: null,
    lastWriteTs: null,
    lastCmdW: null,
    loop: defaultApsLoopState(),
    log: []
  };
}

function normalize(raw: unknown): ApsLoopStore {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = defaultStore();
  const n = (v: unknown, f: number | null): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : f;
  const loop = (o.loop && typeof o.loop === 'object' ? o.loop : {}) as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    observationMode: typeof o.observationMode === 'boolean' ? o.observationMode : d.observationMode,
    lastObs: o.lastObs && typeof o.lastObs === 'object' ? (o.lastObs as ApsObservation) : d.lastObs,
    autoDisabledReason: typeof o.autoDisabledReason === 'string' ? o.autoDisabledReason : null,
    autoDisabledTs: n(o.autoDisabledTs, null),
    rearmDayParis: typeof o.rearmDayParis === 'string' ? o.rearmDayParis : null,
    rearmCount: (n(o.rearmCount, 0) as number) ?? 0,
    confirmFailCount: (n(o.confirmFailCount, 0) as number) ?? 0,
    lastTickTs: n(o.lastTickTs, null),
    lastWriteTs: n(o.lastWriteTs, null),
    lastCmdW: n(o.lastCmdW, null),
    loop: {
      exportSinceTs: n(loop.exportSinceTs, null),
      lastWriteTs: n(loop.lastWriteTs, null),
      lastCmdW: n(loop.lastCmdW, null)
    },
    log: Array.isArray(o.log)
      ? (o.log.filter((e) => !!e && typeof e === 'object') as ApsLogEntry[]).slice(-LOG_MAX)
      : []
  };
}

export async function readApsLoop(): Promise<ApsLoopStore> {
  return readJsonSafe(STATE_FILE, {
    fallback: defaultStore,
    normalize,
    label: 'apsloop-state.json'
  });
}

/** Interrupteur. À l'extinction, on REND le plafond au maximum. */
export async function setApsLoopEnabled(enabled: boolean): Promise<ApsLoopStore> {
  return withFileLock(STATE_FILE, async () => {
    const s = await readApsLoop();
    s.enabled = enabled;
    if (enabled) {
      // Le retour forcé en OBSERVATION après un arrêt de sécurité a été RETIRÉ
      // (29/08/2026). L'intention était prudente — ne pas laisser une panne
      // inexpliquée reprendre la main sur du matériel — mais le résultat était
      // une protection anti-injection rallumée qui ne bridait plus rien, alors
      // que la consigne « aucune réinjection » ne souffre pas d'exception. On
      // rallume donc pour de bon ; ce sont les gardes du tick (onduleur
      // indisponible, quota de réarmements) qui tiennent le risque.
      s.autoDisabledReason = null;
      s.autoDisabledTs = null;
      s.confirmFailCount = 0;
    } else {
      await restoreMax().catch(() => {});
      s.lastCmdW = null;
      s.loop = defaultApsLoopState();
    }
    await writeJsonAtomic(STATE_FILE, s);
    return s;
  });
}

export async function setApsLoopObservation(observation: boolean): Promise<ApsLoopStore> {
  return withFileLock(STATE_FILE, async () => {
    const s = await readApsLoop();
    s.observationMode = observation;
    if (observation) await restoreMax().catch(() => {});
    await writeJsonAtomic(STATE_FILE, s);
    return s;
  });
}

interface ApsRead {
  available: boolean;
  powerW: number;
  maxW: number;
  minLimitW: number;
  maxLimitW: number;
  writeEnabled: boolean;
}

async function readAps(): Promise<ApsRead | null> {
  try {
    const r = await fetch(`${BRIDGE()}/api/apsystems/status`, {
      signal: AbortSignal.timeout(TIMEOUT)
    });
    if (!r.ok) return null;
    const d = (await r.json()) as Record<string, unknown>;
    const num = (v: unknown, f: number) => (typeof v === 'number' && Number.isFinite(v) ? v : f);
    return {
      available: d.available === true,
      powerW: num(d.power_w, 0),
      maxW: num(d.max_power_w, 960),
      minLimitW: num(d.min_power_w, 30),
      maxLimitW: num(d.max_power_limit_w, 960),
      writeEnabled: d.write_enabled === true
    };
  } catch {
    return null;
  }
}

async function readGrid(): Promise<{ available: boolean; gridW: number }> {
  try {
    const r = await fetch(`${EM50()}/rpc/Shelly.GetStatus`, {
      signal: AbortSignal.timeout(TIMEOUT)
    });
    if (!r.ok) return { available: false, gridW: 0 };
    const d = (await r.json()) as Record<string, { act_power?: number }>;
    // Étalonnage CENTRALISÉ (em50-grid.ts). Cette lecture-ci était la seule des
    // cinq à ne pas l'appliquer — oubli du 01/09. Conséquence mesurée : croyant
    // injecter 35 W de plus qu'en réalité, l'anti-injection bridait l'onduleur
    // dès 115 W d'injection réelle au lieu de 150, et ne le relâchait qu'en
    // dessous de 15 W au lieu de 50. De la production perdue pour rien.
    const gridW = calibratedGridW(d[`em1:${Number(env.EM50_GRID_ID ?? 0)}`]?.act_power);
    if (gridW === null) return { available: false, gridW: 0 };
    return { available: true, gridW };
  } catch {
    return { available: false, gridW: 0 };
  }
}

async function writeMax(w: number): Promise<{ ok: boolean; confirmedW: number | null }> {
  const token = TOKEN();
  if (!token) return { ok: false, confirmedW: null };
  try {
    const r = await fetch(`${BRIDGE()}/api/apsystems/maxpower`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ max_power_w: w }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!r.ok) return { ok: false, confirmedW: null };
    const d = (await r.json()) as { ok?: boolean; confirmed_w?: number | null };
    return {
      ok: d.ok === true,
      confirmedW: typeof d.confirmed_w === 'number' ? d.confirmed_w : null
    };
  } catch {
    return { ok: false, confirmedW: null };
  }
}

/** Rend le plafond au maximum de l'appareil (sortie de boucle, sécurité). */
async function restoreMax(): Promise<void> {
  const aps = await readAps();
  const hi = aps?.maxLimitW ?? 960;
  if (aps && aps.maxW >= hi) return; // déjà au maximum
  await writeMax(hi);
}

/**
 * Réarmement automatique après un arrêt de sécurité (décision dans decide.ts,
 * `shouldRearmAps` — pure et testée). Ici on ne fait que le tenir : horloge,
 * quota du jour, lecture du pont, journal et notification.
 */
async function tryAutoRearm(
  s: ApsLoopStore,
  now: number
): Promise<{ rearmed: boolean; note?: string }> {
  if (!s.autoDisabledReason) return { rearmed: false }; // arrêt voulu par Laurent
  if (s.autoDisabledTs === null) {
    // État écrit par une version antérieure : on date l'arrêt maintenant plutôt
    // que de le laisser sans horloge — le réarmement partira du prochain tick.
    s.autoDisabledTs = now;
  }
  const day = parisDay(now);
  if (s.rearmDayParis !== day) {
    s.rearmDayParis = day;
    s.rearmCount = 0;
  }
  // La lecture du pont ne sert qu'à ça : inutile de la faire tant que le délai
  // n'est pas écoulé (un tick toutes les 20 s, la nuit dure douze heures).
  const attendu = s.autoDisabledTs !== null && now - s.autoDisabledTs >= REARM_DELAY_MS;
  const aps = attendu && s.rearmCount < REARM_MAX_PER_DAY ? await readAps() : null;
  const v = shouldRearmAps(s, now, aps, {
    delayMs: REARM_DELAY_MS,
    maxPerDay: REARM_MAX_PER_DAY
  });
  if (!v.rearm) return { rearmed: false, note: v.note ?? undefined };

  const raison = s.autoDisabledReason;
  s.enabled = true;
  s.autoDisabledReason = null;
  s.autoDisabledTs = null;
  s.confirmFailCount = 0;
  s.rearmCount += 1;
  void sendPush({
    title: '↻ Anti-injection onduleur réarmé',
    body: `L'onduleur répond de nouveau (${Math.round(aps?.powerW ?? 0)} W) — le bridage reprend (${s.rearmCount}/${REARM_MAX_PER_DAY} aujourd'hui). Arrêt précédent : ${raison}.`,
    tag: 'apsloop-rearmed',
    severity: 'info',
    url: '/menu/energie'
  });
  return { rearmed: true };
}

export interface ApsTickResult {
  ran: boolean;
  mode: string;
  writtenW: number | null;
  reason: string;
}

export async function apsTick(): Promise<ApsTickResult> {
  return withFileLock(STATE_FILE, async () => {
    const s = await readApsLoop();
    const now = Date.now();
    s.lastTickTs = now;

    if (!s.enabled) {
      const rearm = await tryAutoRearm(s, now);
      if (!rearm.rearmed) {
        await writeJsonAtomic(STATE_FILE, s);
        return {
          ran: false,
          mode: 'off',
          writtenW: null,
          reason: rearm.note ?? s.autoDisabledReason ?? 'boucle désactivée'
        };
      }
      // Réarmée : on enchaîne sur un tick normal, sans attendre 20 s de plus —
      // chaque tick manqué est de l'énergie qui part sur le réseau.
    }

    const [aps, grid] = await Promise.all([readAps(), readGrid()]);
    if (!aps) {
      await writeJsonAtomic(STATE_FILE, s);
      return { ran: false, mode: 'off', writtenW: null, reason: 'pont APS injoignable' };
    }

    const inputs: ApsLoopInputs = {
      now,
      gridW: grid.gridW,
      em50Available: grid.available,
      apsW: aps.powerW,
      apsAvailable: aps.available,
      apsMaxW: aps.maxW,
      apsMinLimitW: aps.minLimitW,
      apsMaxLimitW: aps.maxLimitW
    };
    s.lastObs = {
      ts: now,
      gridW: inputs.gridW,
      apsW: Math.round(inputs.apsW),
      capW: inputs.apsMaxW,
      maxLimitW: inputs.apsMaxLimitW,
      apsAvailable: inputs.apsAvailable,
      em50Available: inputs.em50Available
    };

    const d = decideAps(inputs, defaultApsLoopConfig(), s.loop);
    s.loop = d.nextState;

    // Renouvellement du bail. Le pont rend le plafond au maximum si personne ne le
    // réaffirme (cf. chien de garde côté pont) : tant qu'on bride, on doit donner
    // signe de vie. On réécrit la MÊME valeur — c'est aussi une re-confirmation sur
    // l'appareil. Volontairement HORS de `s.loop` : ce n'est pas une décision, ça ne
    // doit pas relancer l'horloge de dwell de decide().
    let writeW = d.writeW;
    if (
      writeW === null &&
      !s.observationMode &&
      s.lastCmdW !== null &&
      s.lastCmdW < aps.maxLimitW &&
      (s.lastWriteTs === null || now - s.lastWriteTs >= KEEPALIVE_MS)
    )
      writeW = s.lastCmdW;

    // ENDORMI ≠ REFUS. L'EZ1 s'éteint quand il ne produit plus : le pont le
    // signale `available: false`. Écrire un plafond dans ce vide ne peut pas
    // être confirmé — et c'est exactement ce qui a désarmé la protection le
    // 12/08 à 21h23, sur un onduleur simplement couché pour la nuit. Il n'y a
    // de toute façon rien à brider sur un onduleur qui produit 0 W.
    if (writeW !== null && !inputs.apsAvailable) {
      s.lastObs.ts = now;
      await writeJsonAtomic(STATE_FILE, s);
      return {
        ran: true,
        mode: 'hold',
        writtenW: null,
        reason: 'onduleur endormi — rien à brider'
      };
    }

    let confirmedW: number | null = null;
    if (writeW !== null && !s.observationMode) {
      const w = await writeMax(writeW);
      confirmedW = w.confirmedW;
      if (w.ok) {
        s.confirmFailCount = 0;
        s.lastWriteTs = now;
        s.lastCmdW = writeW;
      } else {
        s.confirmFailCount += 1;
        if (s.confirmFailCount >= CONFIRM_FAIL_MAX) {
          s.enabled = false;
          s.autoDisabledReason = `plafond non appliqué ${s.confirmFailCount}× (demandé ${writeW} W)`;
          s.autoDisabledTs = now;
          await restoreMax().catch(() => {});
          // La boucle SB3 notifiait ses arrêts, pas celle-ci : elle s'est
          // éteinte le 12/08 et personne ne l'a su pendant 17 jours.
          void sendPush({
            title: '🛑 Anti-injection onduleur désactivé',
            body: `Le plafond demandé (${writeW} W) n'a pas été appliqué ${s.confirmFailCount}× de suite. Plafond rendu au maximum — la production part sur le réseau. Réarmement automatique dès que l'onduleur répond de nouveau.`,
            tag: 'apsloop-disabled',
            severity: 'critical',
            url: '/menu/energie'
          });
        }
      }
    }

    const entry: ApsLogEntry = {
      ts: now,
      mode: d.mode,
      writtenW: d.writeW,
      confirmedW: d.writeW !== null ? confirmedW : null,
      gridW: inputs.gridW,
      apsW: inputs.apsW,
      maxW: inputs.apsMaxW,
      reason: d.reason
    };
    if (d.writeW !== null || d.mode !== 'hold') s.log = [...s.log, entry].slice(-LOG_MAX);
    await writeJsonAtomic(STATE_FILE, s);

    // Journal : uniquement les décisions notables. Un tick « hold » toutes les 30 s
    // n'apprend rien et noierait journald (~2 900 lignes/jour).
    if (d.writeW !== null || d.mode !== 'hold')
      console.log(
        `[apsloop]${s.observationMode ? ' OBS' : ''} ${d.mode} | réseau=${inputs.gridW}W APS=${Math.round(inputs.apsW)}W plafond=${inputs.apsMaxW}W` +
          (d.writeW !== null
            ? ` → ${s.observationMode ? 'AURAIT écrit' : 'écrit'} ${d.writeW}W`
            : '') +
          ` | ${d.reason}`
      );
    return { ran: true, mode: d.mode, writtenW: d.writeW, reason: d.reason };
  });
}
