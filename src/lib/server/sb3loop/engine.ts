/**
 * Moteur de la boucle SB3 — un tick par appel (timer systemd 60 s).
 *
 * Le tick : collecte → decide() (pur) → écriture éventuelle via le bridge
 * (Bearer) → CONFIRMATION immédiate (le bridge relit le schedule posté) →
 * état persisté (atomic-store) + journal. Deux échecs de confirmation
 * consécutifs → boucle AUTO-DÉSACTIVÉE + Web Push (pattern cumulus).
 *
 * Contrôles de dérive Anker :
 *  - canary de schéma (1er tick du jour Paris + démarrage) : champs attendus
 *    du payload cloud présents, sinon désactivation + notif ;
 *  - version de la lib : check quotidien de la release GitHub vs celle
 *    installée dans le pont — NOTIFICATION SEULE, une fois par nouvelle
 *    version, jamais de mise à jour automatique d'une dépendance qui pilote du
 *    matériel.
 */
import { env } from '$env/dynamic/private';
import { readJsonSafe, writeJsonAtomic, withFileLock } from '$lib/server/atomic-store';
import { sendPush } from '$lib/server/monitor/push';
import { parisDate } from '$lib/server/tariffs';
import { collectSb3Inputs } from './inputs';
import {
  classifyWrite,
  cloudFailed,
  cloudRetryAt,
  decide,
  feedforwardTarget,
  libUpdateToNotify,
  shouldRearmSb3
} from './decide';
import {
  defaultSb3LoopConfig,
  defaultSb3LoopState,
  type Sb3DecisionLogEntry,
  type Sb3LoopConfig,
  type Sb3LoopState,
  type Sb3PlanSlot,
  type Sb3WriteResult
} from './types';

import path from 'node:path';

const STATE_FILE = path.join(path.resolve(process.cwd(), 'data'), 'sb3loop-state.json');
const LOG_MAX = 100;
/**
 * Version de anker-solix-api INSTALLÉE dans l'image du pont — tenue À LA MAIN.
 * Le pont ne l'expose pas (`/api/health` ne donne que `library_available`, et
 * `version` de FastAPI est celle du pont lui-même) : Domo ne peut pas la lire.
 * Restée sur v3.6.3 alors que le pont passait en v3.8.1 le 04/09, elle faisait
 * annoncer chaque jour une « version épinglée » fausse.
 * À CHANGER DANS LE MÊME GESTE que le `@vX.Y.Z` de /home/laurent/anker-bridge/
 * Dockerfile (RPi4) et la reconstruction de l'image ; contrôle :
 * `docker exec anker-bridge pip show anker-solix-api`.
 */
const INSTALLED_LIB_VERSION = 'v3.8.1';

const bridgeUrl = () => (env.ANKER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');

async function loadState(): Promise<Sb3LoopState> {
  return readJsonSafe(STATE_FILE, {
    fallback: defaultSb3LoopState,
    normalize: (raw: unknown): Sb3LoopState => ({ ...defaultSb3LoopState(), ...(raw as object) }),
    label: 'sb3loop-state'
  });
}

export async function getSb3LoopState(): Promise<Sb3LoopState> {
  return loadState();
}

/** Interrupteur de la tuile : (dés)active la boucle, efface l'auto-disable. */
export async function setSb3LoopEnabled(enabled: boolean): Promise<Sb3LoopState> {
  return withFileLock(STATE_FILE, async () => {
    const s = await loadState();
    s.enabled = enabled;
    if (enabled) {
      s.autoDisabledReason = null;
      s.autoDisabledTs = null;
      s.confirmFailCount = 0;
      s.transportFailCount = 0;
      // Repart sur un budget de restauration neuf : la boucle va de toute façon
      // réécrire les créneaux, et un abandon passé ne doit pas la condamner.
      s.restoreAttempts = 0;
    }
    await writeJsonAtomic(STATE_FILE, s);
    return s;
  });
}

/**
 * Battement de cœur du BAIL de consigne — appel LOCAL au pont, AUCUN appel cloud.
 * En mode personnalisé, une écriture GRAVE la valeur dans le créneau du plan, et
 * l'entrée couvrant week=[0..6] elle vaut les SEPT JOURS : si Domo meurt, la
 * dernière consigne reste en place et un système SB3 SANS COMPTEUR la débiterait
 * à l'aveugle chaque jour. Le pont rend donc le plan statique de lui-même si ce
 * battement s'arrête. Il est volontairement LOCAL : renouveler par une réécriture
 * cloud coûterait des centaines d'écritures par jour et ruinerait à la fois le
 * quota Anker et la mesure du taux d'écriture en cours.
 */
async function heartbeatLease(safePresetW: number | null): Promise<void> {
  const token = env.SB3_BRIDGE_WRITE_TOKEN;
  if (!token) return;
  try {
    await fetch(`${bridgeUrl()}/api/sb3/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // Le battement porte AUSSI le repli : un bail ouvert juste avant un
      // redéploiement garderait sinon `safe: null` et resterait NON protégé
      // jusqu'à la prochaine écriture (constaté le 30/07).
      body: JSON.stringify({ safe_preset: safePresetW }),
      signal: AbortSignal.timeout(8_000)
    });
  } catch {
    /* le pont est injoignable : c'est justement le cas que son bail couvre */
  }
}

/** Écriture de la consigne via le pont (login owner + POST + relecture cloud).
 *  `timeoutMs` : le tick de la boucle laisse le plein budget (45 s) ; le
 *  pré-armement cumulus, lui, est borné plus court — au-delà, on ferme le
 *  relais quand même et l'écriture atterrit juste après (toujours utile). */
async function writePreset(
  presetW: number,
  safePresetW: number | null,
  timeoutMs = 45_000
): Promise<Sb3WriteResult> {
  const token = env.SB3_BRIDGE_WRITE_TOKEN;
  if (!token) return { ok: false, confirmedW: null, reached: false, cloudDown: false };
  presetW = Math.round(Math.min(2400, Math.max(0, presetW)));
  try {
    const r = await fetch(`${bridgeUrl()}/api/sb3/output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // safe_preset = valeur du plan STATIQUE pour le créneau courant : c'est elle
      // que le pont rendra tout seul si le bail expire. Le plan statique reste
      // défini ici (config Domo), le pont ne le devine pas.
      body: JSON.stringify({ preset: presetW, safe_preset: safePresetW }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Le pont a RÉPONDU, même en erreur. Un 502, c'est son appel au CLOUD qui a
    // levé une exception (Anker en panne, timeout) : la consigne n'a pas été
    // jugée — cf. classifyWrite(). 400/401/503 sont des fautes de configuration.
    if (!r.ok) return { ok: false, confirmedW: null, reached: true, cloudDown: r.status === 502 };
    const d = (await r.json()) as { ok?: boolean; confirmed_w?: number | null };
    return {
      ok: d.ok === true,
      confirmedW: typeof d.confirmed_w === 'number' ? d.confirmed_w : null,
      reached: true,
      cloudDown: false
    };
  } catch {
    // Réseau coupé, tunnel Tailscale tombé, budget de 45 s dépassé : le pont
    // n'a rien vu passer. Rien n'a été écrit — rien n'est à réparer non plus.
    return { ok: false, confirmedW: null, reached: false, cloudDown: false };
  }
}

/** Panne cloud en cours et prochain essai pas encore dû : ne rien envoyer. */
function cloudRetryPending(state: Sb3LoopState, cfg: Sb3LoopConfig, now: number): boolean {
  const at = cloudRetryAt(state, cfg);
  return at !== null && now < at;
}

/** Le pont a répondu 502 : on espace l'essai suivant, et on prévient une seule
 *  fois si la panne dure — sans jamais couper la boucle (rien à y gagner). */
function noteCloudDown(state: Sb3LoopState, cfg: Sb3LoopConfig, now: number): void {
  const { streak, alert } = cloudFailed(state, cfg, now);
  Object.assign(state, streak);
  if (alert) {
    void sendPush({
      title: '☁️ Cloud Anker en panne',
      body: `Les consignes SB3 n'arrivent plus au cloud Anker depuis ${parisHm(streak.cloudDownSinceTs ?? now)} (erreur côté Anker). Rien à corriger à la main : Domo réessaie seul et reprend dès que le cloud répond ; d'ici là, la consigne en place ne bouge pas.`,
      tag: 'sb3loop-cloud-down',
      severity: 'warning',
      url: '/energie'
    });
  }
}

/** Le cloud a répondu (consigne prise, bornée ou refusée) : fin de la panne.
 *  Pas de notification de retour : elle partirait à la prochaine écriture, qui
 *  peut attendre des heures dans la bande morte — un « revenu » daté de midi
 *  pour une panne finie à 8 h induirait en erreur. */
function noteCloudUp(state: Sb3LoopState): void {
  state.cloudFailCount = 0;
  state.cloudDownSinceTs = null;
  state.cloudLastFailTs = null;
}

/** Suffixe de journal d'une écriture différée ou perdue pour panne cloud. */
function cloudDownNote(state: Sb3LoopState, cfg: Sb3LoopConfig, what: string): string {
  const at = cloudRetryAt(state, cfg);
  return `cloud Anker en panne, ${what}${at !== null ? ` (nouvel essai vers ${parisHm(at)})` : ''}`;
}

/** Champs cloud dont dépend la boucle — le canary vérifie leur présence. */
function canaryOk(payload: Record<string, unknown>): string | null {
  if (payload.sb3_output_power_w === undefined) return 'sb3_output_power_w absent';
  if (payload.sb3_current_preset_w === undefined) return 'sb3_current_preset_w absent';
  if (payload.sb3_scene_mode === undefined) return 'sb3_scene_mode absent';
  const bats = payload.batteries;
  if (!Array.isArray(bats)) return 'batteries[] absent';
  const sb3 = bats.filter((b) => (b as { model?: string }).model === 'A17C5') as {
    soc?: unknown;
  }[];
  if (sb3.length < 2) return `batteries A17C5 : ${sb3.length}/2`;
  if (!sb3.every((b) => typeof b.soc === 'number')) return 'soc A17C5 non numérique';
  return null;
}

async function runCanary(): Promise<string | null> {
  try {
    const r = await fetch(`${bridgeUrl()}/api/status`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return `bridge HTTP ${r.status}`;
    return canaryOk((await r.json()) as Record<string, unknown>);
  } catch (e) {
    return `bridge injoignable (${e instanceof Error ? e.message : 'erreur'})`;
  }
}

/** `dejaSignalee` : dernière release annoncée (état lu par le tick). Lancé
 *  sans attendre, le check reprend le verrou pour la mémoriser : il passe
 *  simplement après le tick en cours. */
async function checkLibVersion(dejaSignalee: string | null): Promise<void> {
  try {
    const r = await fetch(
      'https://api.github.com/repos/thomluther/anker-solix-api/releases/latest',
      {
        signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/vnd.github+json' }
      }
    );
    if (!r.ok) return;
    const d = (await r.json()) as { tag_name?: unknown };
    const tag = libUpdateToNotify(d.tag_name, INSTALLED_LIB_VERSION, dejaSignalee);
    if (tag === null) return;
    const recus = await sendPush({
      title: '📦 anker-solix-api : nouvelle version',
      body: `${tag} disponible (installée sur le pont : ${INSTALLED_LIB_VERSION}). Aucune mise à jour automatique — à évaluer avant de toucher au bridge.`,
      tag: 'sb3loop-lib-version',
      severity: 'info',
      url: '/energie'
    });
    // Mémorisée seulement si elle est PARTIE : sans abonné joignable, on
    // réessaie le lendemain plutôt que de la taire pour de bon.
    if (recus === 0) return;
    await withFileLock(STATE_FILE, async () => {
      const s = await loadState();
      s.libVersionNotified = tag;
      await writeJsonAtomic(STATE_FILE, s);
    });
  } catch {
    /* check best-effort — jamais bloquant */
  }
}

/** Budget d'écriture du feedforward : bien plus court que les 45 s du tick —
 *  l'appelant (moteur cumulus) ne peut pas attendre le plein aller-retour. */
const FF_WRITE_TIMEOUT_MS = 15_000;

export interface FeedforwardOutcome {
  /** Écriture posée ET confirmée par le pont. */
  wrote: boolean;
  targetW: number | null;
  note: string;
}

/**
 * FEEDFORWARD de l'échelon cumulus (étude §8, banc apparié §10) : le seul
 * échelon de 2,9 kW PRÉVISIBLE est celui que nous commandons nous-mêmes.
 *
 *  - stepW > 0 (pré-armement) : monter la part SB3 AVANT de fermer le relais
 *    supprime le transitoire d'achat EDF à la source (−71 % mesuré au banc sur
 *    les allumages qui achetaient) — la Max AC n'a plus à monter seule en
 *    butée pendant que les SB3 attendent le cloud.
 *  - stepW < 0 (désarmement) : rendre la part SB3 à l'ouverture évite le
 *    recyclage SB3 → Max AC de la descente progressive (64 → 9 Wh au banc)
 *    et l'injection qui l'accompagne quand la Max AC n'absorbe pas.
 *
 * Best-effort par construction : boucle inactive, mesures muettes, cloud
 * périmé ou mode Anker ≠ manuel ⇒ aucune écriture, l'appelant continue comme
 * aujourd'hui. La part suit la RÈGLE 2 (prorata d'énergie utilisable) ; les
 * protections zéro-import du pilote cumulus restent le filet.
 */
export async function feedforwardCumulusStep(stepW: number): Promise<FeedforwardOutcome> {
  return withFileLock(STATE_FILE, async () => {
    const cfg = defaultSb3LoopConfig();
    const state = await loadState();
    if (!state.enabled || state.autoDisabledReason !== null) {
      return { wrote: false, targetW: null, note: 'boucle SB3 inactive — pas de feedforward' };
    }
    const now = Date.now();
    // Panne cloud en cours : l'écriture échouerait, après avoir fait attendre
    // la fermeture du relais du cumulus jusqu'à 15 s pour rien.
    if (cloudRetryPending(state, cfg, now)) {
      return { wrote: false, targetW: null, note: 'cloud Anker en panne — pas de feedforward' };
    }
    const inputs = await collectSb3Inputs(cfg);
    const t = feedforwardTarget(inputs, cfg, state, stepW);
    if (!t.ok) return { wrote: false, targetW: null, note: t.reason };

    // Créneau marqué AVANT l'écriture (même logique que le tick) : non
    // confirmée, elle a pu être appliquée côté cloud → à restaurer plus tard.
    const slot = planSlot(cfg, now);
    if (slot !== null && !state.pendingRestoreSlots.includes(slot)) {
      state.pendingRestoreSlots.push(slot);
    }
    const w = await writePreset(
      t.targetW,
      slot !== null ? staticPlanW(cfg, slot) : null,
      FF_WRITE_TIMEOUT_MS
    );
    const verdict = classifyWrite(w, t.targetW, cfg);
    if (verdict === 'cloud-down') noteCloudDown(state, cfg, now);
    else if (verdict !== 'unreachable') noteCloudUp(state);
    const pris = verdict === 'confirmed' || verdict === 'clamped';
    if (pris) {
      // On enregistre ce que le matériel a RÉELLEMENT pris, pas ce qu'on visait :
      // c'est cette valeur qui sert de base au tick suivant. Une cible bornée
      // enregistrée comme cible ferait croire à la boucle qu'elle sur-livre.
      state.lastCmdW = verdict === 'confirmed' ? t.targetW : (w.confirmedW as number);
      state.lastWriteTs = now; // settle : la boucle substitue la consigne écrite
      if (stepW > 0) {
        // L'excédent transitoire d'ici la fermeture du relais est VOULU : la
        // boucle ne doit pas le « corriger » en annulant le pré-armement.
        // (Les montées restent libres — règle 1 intouchée.) Armé AUSSI quand la
        // consigne a été bornée : c'est justement le cas où la marge est mince,
        // celui où l'annuler coûte un achat EDF.
        state.ffHoldUntilTs = now + cfg.ffHoldS * 1000;
      }
    }
    // Pas d'escalade confirmFailCount ici : la politique d'auto-désactivation
    // appartient aux écritures de la boucle elle-même — un feedforward raté
    // laisse simplement le comportement d'aujourd'hui.
    const suffixe =
      verdict === 'confirmed'
        ? ''
        : verdict === 'clamped'
          ? ` (bornée à ${Math.round(w.confirmedW as number)} W par le parc)`
          : verdict === 'unreachable'
            ? ' (pont injoignable — rien écrit)'
            : verdict === 'cloud-down'
              ? ` (${cloudDownNote(state, cfg, 'rien écrit')})`
              : ' (NON confirmée)';
    const note =
      `${stepW > 0 ? 'PRÉ-ARMEMENT' : 'DÉSARMEMENT'} cumulus ${stepW > 0 ? '+' : '−'}` +
      `${Math.abs(Math.round(stepW))} W — part SB3 ${t.sharePct} % : consigne ` +
      `${t.baseW} → ${t.targetW} W${suffixe}`;
    pushLog(state, {
      ts: now,
      mode: 'allocate',
      reason: note,
      houseLoadW: null,
      targetW: t.targetW,
      beforeW: t.baseW,
      writtenW: t.targetW,
      confirmedW: w.confirmedW
    });
    await writeJsonAtomic(STATE_FILE, state);
    return { wrote: pris, targetW: t.targetW, note };
  });
}

export interface Sb3TickResult {
  ok: boolean;
  enabled: boolean;
  mode: string;
  reason: string;
  houseLoadW: number | null;
  targetW: number | null;
  writtenW: number | null;
  confirmedW: number | null;
  autoDisabledReason: string | null;
}

export async function sb3LoopTick(): Promise<Sb3TickResult> {
  return withFileLock(STATE_FILE, async () => {
    const cfg = defaultSb3LoopConfig();
    const state = await loadState();
    const now = Date.now();
    state.lastTickTs = now;
    const today = parisDate(new Date(now));

    // ── Canary schéma (démarrage + quotidien), AVANT toute décision. ──
    if (state.lastCanaryDayParis !== today) {
      const fault = await runCanary();
      state.lastCanaryDayParis = today;
      // Réarmement QUOTIDIEN des tentatives de restauration : un échec nocturne
      // (incident 23/07 : confirmation impossible sur créneau traversant minuit)
      // ne doit pas condamner la restauration du matin, qui elle aboutit.
      state.restoreAttempts = 0;
      if (fault !== null && state.enabled) {
        state.enabled = false;
        state.autoDisabledReason = `canary schéma : ${fault}`;
        state.autoDisabledTs = now;
        void sendPush({
          title: '🛑 Boucle SB3 désactivée',
          body: `Le canary a détecté un changement de schéma cloud : ${fault}. Réactivation manuelle après vérification.`,
          tag: 'sb3loop-disabled',
          severity: 'critical',
          url: '/energie'
        });
      }
    }
    if (state.lastVersionCheckDayParis !== today) {
      state.lastVersionCheckDayParis = today;
      void checkLibVersion(state.libVersionNotified);
    }

    if (!state.enabled) {
      // Un arrêt de sécurité ne peut pas être définitif : la consigne « aucune
      // réinjection » ne s'interrompt pas. Le 29/08/2026, la boucle s'est coupée
      // à 11h43 sur deux consignes non confirmées et est restée éteinte jusqu'au
      // soir — parc bloqué à 0 W de sortie, batteries pleines, tout le solaire
      // parti sur le réseau. Elle se réarme donc d'elle-même quand le cloud
      // redevient sain, avec un quota journalier. EXCEPTION : une faute de
      // schéma (canary) ne se répare pas toute seule, elle attend un humain.
      const rearm = tryAutoRearm(state, now);
      if (rearm.rearmed) {
        void sendPush({
          title: '↻ Boucle SB3 réarmée',
          body: `Le cloud Anker répond de nouveau — la consigne de sortie suit à nouveau la maison (${state.rearmCount}/${REARM_MAX_PER_DAY} aujourd'hui). Arrêt précédent : ${rearm.previousReason}.`,
          tag: 'sb3loop-rearmed',
          severity: 'info',
          url: '/menu/energie'
        });
      }
    }

    if (!state.enabled) {
      // Boucle à l'arrêt : tant qu'un créneau porte encore une consigne de la
      // boucle, on le rend au plan statique avant de sortir.
      const restore = await restoreStaticPlan(state, cfg, now);
      // Une note sans écriture (« en attente du créneau nuit », « différée ») se
      // répète à chaque tick : ne journaliser que ses changements, sinon elle
      // chasse du ring de 100 lignes tout ce qui précède en une demi-heure.
      const nouvelle =
        restore !== null &&
        (restore.writtenW !== null ||
          state.decisions[0]?.mode !== 'off' ||
          state.decisions[0]?.reason !== restore.note);
      if (restore && nouvelle) {
        pushLog(state, {
          ts: now,
          mode: 'off',
          reason: restore.note,
          houseLoadW: null,
          targetW: restore.writtenW,
          beforeW: state.lastCmdW,
          writtenW: restore.writtenW,
          confirmedW: restore.confirmedW
        });
      }
      await writeJsonAtomic(STATE_FILE, state);
      const base = state.autoDisabledReason ?? 'boucle désactivée';
      return result(
        state,
        'off',
        restore ? `${base} — ${restore.note}` : base,
        null,
        null,
        restore?.writtenW ?? null,
        restore?.confirmedW ?? null
      );
    }

    // Le bail se renouvelle à chaque tick, même quand aucune écriture n'a lieu :
    // c'est précisément la bande morte (donc l'absence d'écriture) qui rendrait un
    // renouvellement par réécriture cloud absurde.
    {
      const hbSlot = planSlot(cfg, now);
      void heartbeatLease(hbSlot !== null ? staticPlanW(cfg, hbSlot) : null);
    }

    const inputs = await collectSb3Inputs(cfg);
    const d = decide(inputs, cfg, state);
    // Panne cloud en cours, prochain essai pas encore dû : la décision est
    // journalisée mais rien ne part. Ses effets de bord ne sont donc PAS
    // appliqués — une correction « en vol » qui n'a jamais volé fausserait le
    // prédicteur, et un biais lent déclaré corrigé ne le serait pas.
    const differee = d.writeW !== null && cloudRetryPending(state, cfg, now);
    if (!differee) {
      state.enVol = d.enVol;
      state.slow = d.slow;
    }

    let writtenW: number | null = null;
    let confirmedW: number | null = null;
    if (differee) {
      const reason = `${d.reason} — ${cloudDownNote(state, cfg, 'écriture différée')}`;
      if (state.decisions[0]?.mode !== d.mode || state.decisions[0]?.reason !== reason) {
        pushLog(state, {
          ts: now,
          mode: d.mode,
          reason,
          houseLoadW: d.houseLoadW,
          targetW: d.targetW,
          beforeW: state.lastCmdW ?? inputs.cloud.sb3PresetW,
          writtenW: null,
          confirmedW: null
        });
      }
      await writeJsonAtomic(STATE_FILE, state);
      return result(state, d.mode, reason, d.houseLoadW, d.targetW, null, null);
    }
    if (d.writeW !== null) {
      const beforeW = state.lastCmdW ?? inputs.cloud.sb3PresetW;
      // Créneau marqué AVANT l'écriture : même non confirmée, elle a pu être
      // appliquée côté cloud, donc ce créneau devra être rendu au plan statique.
      const slot = planSlot(cfg, now);
      if (slot !== null && !state.pendingRestoreSlots.includes(slot)) {
        state.pendingRestoreSlots.push(slot);
      }
      const w = await writePreset(d.writeW, slot !== null ? staticPlanW(cfg, slot) : null);
      writtenW = d.writeW;
      confirmedW = w.confirmedW;
      const verdict = classifyWrite(w, d.writeW, cfg);
      if (verdict === 'unreachable') {
        // Rien n'est parti : ni consigne à enregistrer, ni refus à compter. On
        // suit la panne à part et on réessaie au tick suivant — c'est la seule
        // façon que la boucle reparte SEULE quand le réseau revient.
        state.transportFailCount += 1;
        if (state.transportFailCount === cfg.transportFailAlert) {
          void sendPush({
            title: '⚠️ Pont Anker injoignable',
            body: `${state.transportFailCount} écritures de consigne SB3 perdues d'affilée (le pont ne répond pas). La boucle reste ACTIVE et réessaie ; le bail rendra le plan statique tout seul si la panne dure.`,
            tag: 'sb3loop-bridge-unreachable',
            severity: 'warning',
            url: '/energie'
          });
        }
      } else if (verdict === 'cloud-down') {
        // Le pont a parlé, le cloud non : ni consigne à enregistrer, ni refus à
        // compter. La boucle reste active, l'essai suivant est espacé.
        state.transportFailCount = 0;
        noteCloudDown(state, cfg, now);
      } else if (verdict !== 'failed') {
        state.transportFailCount = 0;
        noteCloudUp(state);
        // Bornée par le parc = commande PRISE : on garde la valeur en place comme
        // base, et on ne fait surtout pas monter le compteur d'échecs (il coupe
        // la boucle au 2ᵉ coup, cf. l'auto-désactivation du 21/08).
        state.lastCmdW = verdict === 'confirmed' ? d.writeW : (w.confirmedW as number);
        state.lastWriteTs = now;
        state.confirmFailCount = 0;
      } else {
        state.transportFailCount = 0;
        noteCloudUp(state);
        state.confirmFailCount += 1;
        if (state.confirmFailCount >= cfg.confirmFailMax) {
          state.enabled = false;
          state.autoDisabledReason = `consigne non prise ${state.confirmFailCount}× (écrit ${d.writeW} W, confirmé ${w.confirmedW ?? '—'})`;
          state.autoDisabledTs = now;
          void sendPush({
            title: '🛑 Boucle SB3 désactivée',
            body: `Le cloud Anker ne prend plus les consignes (${state.confirmFailCount}× de suite). Restauration du plan statique tentée aux prochains ticks (${cfg.restoreAttemptsMax} essais, puis notification si elle échoue).`,
            tag: 'sb3loop-disabled',
            severity: 'critical',
            url: '/energie'
          });
        }
      }
      pushLog(state, {
        ts: now,
        mode: d.mode,
        reason:
          verdict === 'clamped'
            ? `${d.reason} — bornée à ${Math.round(w.confirmedW as number)} W par le parc`
            : verdict === 'unreachable'
              ? `${d.reason} — pont injoignable, rien écrit`
              : verdict === 'cloud-down'
                ? `${d.reason} — ${cloudDownNote(state, cfg, 'rien écrit')}`
                : d.reason,
        houseLoadW: d.houseLoadW,
        targetW: d.targetW,
        beforeW,
        writtenW,
        confirmedW
      });
    } else if (state.decisions[0]?.mode !== d.mode || state.decisions[0]?.reason !== d.reason) {
      // Journal des changements d'état seulement (pas 1 440 lignes/jour).
      pushLog(state, {
        ts: now,
        mode: d.mode,
        reason: d.reason,
        houseLoadW: d.houseLoadW,
        targetW: d.targetW,
        beforeW: state.lastCmdW ?? inputs.cloud.sb3PresetW,
        writtenW: null,
        confirmedW: null
      });
    }

    await writeJsonAtomic(STATE_FILE, state);
    return result(state, d.mode, d.reason, d.houseLoadW, d.targetW, writtenW, confirmedW);
  });
}

/** Délai minimal avant qu'un arrêt de sécurité se réarme tout seul. */
const REARM_DELAY_MS = 15 * 60_000;
/** Réarmements automatiques autorisés par journée (Paris). */
const REARM_MAX_PER_DAY = 4;

/**
 * Réarmement automatique après un arrêt de sécurité (décision dans decide.ts,
 * `shouldRearmSb3` — pure et testée). Ici : horloge, quota du jour, remise à
 * zéro des compteurs d'échec.
 */
function tryAutoRearm(
  state: Sb3LoopState,
  now: number
): { rearmed: boolean; previousReason: string } {
  const reason = state.autoDisabledReason ?? '';
  if (state.autoDisabledReason && state.autoDisabledTs === null) state.autoDisabledTs = now;
  const day = parisDay(now);
  if (state.rearmDayParis !== day) {
    state.rearmDayParis = day;
    state.rearmCount = 0;
  }
  if (!shouldRearmSb3(state, now, { delayMs: REARM_DELAY_MS, maxPerDay: REARM_MAX_PER_DAY }))
    return { rearmed: false, previousReason: reason };

  state.enabled = true;
  state.autoDisabledReason = null;
  state.autoDisabledTs = null;
  state.confirmFailCount = 0;
  state.transportFailCount = 0;
  state.restoreAttempts = 0;
  state.rearmCount += 1;
  return { rearmed: true, previousReason: reason };
}

const PARIS_DAY_FMT = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' });
const parisDay = (ts: number) => PARIS_DAY_FMT.format(new Date(ts));

const PARIS_HOUR_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  hourCycle: 'h23'
});

const PARIS_HM_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
/** « 08:14 », heure de Paris — pour les messages et le journal. */
const parisHm = (ts: number) => PARIS_HM_FMT.format(new Date(ts));

/** Heure Paris (0-23), ou NaN si indéterminable.
 *  formatToParts et PAS format() : en locale fr, format() rend « 23 h » et le
 *  Number() d'origine donnait NaN — `night` était donc TOUJOURS faux et le plan
 *  statique valait toujours la valeur JOUR, y compris en pleine nuit. */
function parisHour(ts: number): number {
  const part = PARIS_HOUR_FMT.formatToParts(new Date(ts)).find((p) => p.type === 'hour');
  return part ? Number(part.value) : NaN;
}

/** Créneau du plan statique couvrant l'instant t, ou null si l'heure est
 *  indéterminable — dans ce cas on n'écrit RIEN : graver la mauvaise valeur
 *  dans un créneau la fige pour 7 jours. */
function planSlot(cfg: ReturnType<typeof defaultSb3LoopConfig>, ts: number): Sb3PlanSlot | null {
  const h = parisHour(ts);
  if (!Number.isFinite(h)) return null;
  const night = h >= cfg.staticNightStartH || h < cfg.staticNightEndH;
  return night ? 'night' : 'day';
}

/** Valeur du plan statique (les créneaux posés dans l'app) pour un créneau. */
function staticPlanW(cfg: ReturnType<typeof defaultSb3LoopConfig>, slot: Sb3PlanSlot): number {
  return slot === 'night' ? cfg.staticNightW : cfg.staticDayW;
}

interface RestoreOutcome {
  note: string;
  writtenW: number | null;
  confirmedW: number | null;
}

/**
 * Restauration du plan statique après l'arrêt de la boucle (manuel OU auto).
 *
 * Sans elle, la dernière consigne écrite reste gravée dans le créneau Anker
 * jusqu'à correction manuelle dans l'app : arrivé le 23/07/2026 (2 400 W laissés
 * en place après auto-désactivation). Un arrêt de sécurité doit DÉSARMER
 * l'actionneur, pas seulement cesser de le commander.
 *
 * Un créneau ne peut être restauré que PENDANT ce créneau (l'écriture cloud ne
 * modifie que l'entrée couvrant l'heure locale). Si la boucle a touché le
 * créneau jour et qu'on est passé en nuit, on attend le retour du jour — sans
 * consommer de tentative.
 */
async function restoreStaticPlan(
  state: Sb3LoopState,
  cfg: ReturnType<typeof defaultSb3LoopConfig>,
  now: number
): Promise<RestoreOutcome | null> {
  if (state.pendingRestoreSlots.length === 0) return null;
  if (state.restoreAttempts >= cfg.restoreAttemptsMax) {
    return {
      note: 'restauration abandonnée — à corriger dans l’app Anker',
      writtenW: null,
      confirmedW: null
    };
  }

  const slot = planSlot(cfg, now);
  if (slot === null) return null;
  if (!state.pendingRestoreSlots.includes(slot)) {
    const waiting = state.pendingRestoreSlots.join('+');
    return {
      note: `restauration en attente du créneau ${waiting}`,
      writtenW: null,
      confirmedW: null
    };
  }

  if (cloudRetryPending(state, cfg, now)) {
    return {
      note: `restauration ${slot} différée — ${cloudDownNote(state, cfg, 'essai espacé')}`,
      writtenW: null,
      confirmedW: null
    };
  }

  const target = staticPlanW(cfg, slot);
  // On écrit le plan statique ET on le déclare comme repli : le pont referme
  // alors le bail (plus rien à surveiller).
  const w = await writePreset(target, target);
  const verdict = classifyWrite(w, target, cfg);
  if (verdict === 'unreachable') {
    // Le pont n'a rien reçu : la tentative n'a pas eu lieu. La compter userait
    // les 3 essais sur une panne réseau et déclencherait l'alerte « plan non
    // restauré » alors que rien n'a été tenté.
    return {
      note: `restauration ${slot} différée — pont injoignable`,
      writtenW: null,
      confirmedW: null
    };
  }
  if (verdict === 'cloud-down') {
    // Même chose un cran plus loin : le cloud n'a pas jugé la consigne. Le
    // 24/09, ces 502 comptés comme des refus ont grillé les 3 essais en 46 s et
    // demandé une correction à la main — que le retour du cloud rendait inutile.
    noteCloudDown(state, cfg, now);
    return {
      note: `restauration ${slot} différée — ${cloudDownNote(state, cfg, 'essai espacé')}`,
      writtenW: null,
      confirmedW: null
    };
  }
  noteCloudUp(state);

  if (verdict === 'confirmed') {
    state.pendingRestoreSlots = state.pendingRestoreSlots.filter((s) => s !== slot);
    state.restoreAttempts = 0;
    // Plus rien de gravé par la boucle : l'ancrage du slew redevient nul.
    if (state.pendingRestoreSlots.length === 0) state.lastCmdW = null;
    return {
      note: `plan statique restauré (créneau ${slot} → ${target} W)`,
      writtenW: target,
      confirmedW: w.confirmedW
    };
  }

  state.restoreAttempts += 1;
  if (state.restoreAttempts >= cfg.restoreAttemptsMax) {
    void sendPush({
      title: '⚠️ Plan SB3 non restauré',
      body: `Impossible de rendre le créneau ${slot} à ${target} W après ${state.restoreAttempts} tentatives. La dernière consigne de la boucle reste ACTIVE dans le plan Anker — à corriger à la main dans l'app.`,
      tag: 'sb3loop-restore-failed',
      severity: 'critical',
      url: '/energie'
    });
  }
  return {
    note: `échec restauration ${slot} (${state.restoreAttempts}/${cfg.restoreAttemptsMax})`,
    writtenW: target,
    confirmedW: w.confirmedW
  };
}

function pushLog(state: Sb3LoopState, entry: Sb3DecisionLogEntry): void {
  state.decisions.unshift(entry);
  if (state.decisions.length > LOG_MAX) state.decisions.length = LOG_MAX;
}

function result(
  state: Sb3LoopState,
  mode: string,
  reason: string,
  houseLoadW: number | null,
  targetW: number | null,
  writtenW: number | null,
  confirmedW: number | null
): Sb3TickResult {
  return {
    ok: true,
    enabled: state.enabled,
    mode,
    reason,
    houseLoadW,
    targetW,
    writtenW,
    confirmedW,
    autoDisabledReason: state.autoDisabledReason
  };
}
