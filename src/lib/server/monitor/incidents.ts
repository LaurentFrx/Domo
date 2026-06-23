/**
 * Bus d'incidents central — la source unique de vérité de « qu'est-ce qui ne va
 * pas en ce moment ».
 *
 * En mémoire (Map bornée) + persistance best-effort (`data/incidents.json`) pour
 * survivre à un redémarrage. Lu par :
 *   - `/api/health` (bandeau in-app + page de statut),
 *   - le moniteur (`/api/monitor/tick`) qui envoie les alertes Web Push et
 *     déclenche l'auto-réparation.
 *
 * Volontairement SANS dépendance à `atomic-store` (éviterait un cycle ; ces
 * données de monitoring sont tolérantes à la perte). Idempotent par `key` :
 * deux détections de la même anomalie ne créent qu'un incident (compteur +1).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Severity = 'critical' | 'warning' | 'info';

export interface Incident {
  /** Identité stable de l'anomalie (`source:kind`) — clé de déduplication. */
  key: string;
  severity: Severity;
  source: string;
  kind: string;
  message: string;
  firstTs: number;
  lastTs: number;
  count: number;
  /** epoch ms de résolution, ou null si toujours active. */
  resolvedTs: number | null;
  /** Description de l'auto-réparation appliquée, le cas échéant. */
  repaired: string | null;
  /** Une alerte (Web Push) a-t-elle déjà été émise pour cette occurrence ? */
  notified: boolean;
}

const FILE = path.resolve(process.cwd(), 'data', 'incidents.json');
const MAX = 200;
const map = new Map<string, Incident>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const arr = JSON.parse(readFileSync(FILE, 'utf-8')) as Incident[];
    if (Array.isArray(arr)) for (const i of arr) if (i && i.key) map.set(i.key, i);
  } catch {
    /* absent/corrompu : le monitoring repart à vide, c'est tolérable */
  }
}

function persist(): void {
  try {
    const arr = [...map.values()].slice(-MAX);
    writeFileSync(FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch {
    /* best-effort : ne jamais faire échouer un appelant pour du monitoring */
  }
}

export interface RaiseInput {
  key: string;
  severity: Severity;
  source: string;
  kind: string;
  message: string;
}

/**
 * Signale une anomalie. `isNew` vaut true si c'est une occurrence neuve (jamais
 * vue, ou ré-apparue après résolution) → c'est le signal « il faut alerter ».
 */
export function raiseIncident(input: RaiseInput): { incident: Incident; isNew: boolean } {
  ensureLoaded();
  const now = Date.now();
  const existing = map.get(input.key);
  if (existing && existing.resolvedTs === null) {
    existing.lastTs = now;
    existing.count += 1;
    existing.message = input.message;
    existing.severity = input.severity;
    persist();
    return { incident: existing, isNew: false };
  }
  const incident: Incident = {
    key: input.key,
    severity: input.severity,
    source: input.source,
    kind: input.kind,
    message: input.message,
    firstTs: now,
    lastTs: now,
    count: 1,
    resolvedTs: null,
    repaired: null,
    notified: false
  };
  map.set(input.key, incident);
  persist();
  return { incident, isNew: true };
}

/**
 * Marque une anomalie résolue (la source est revenue à la normale). Renvoie true
 * si elle était effectivement active (→ on peut notifier le retour à la normale).
 */
export function resolveIncident(key: string, repaired?: string): boolean {
  ensureLoaded();
  const existing = map.get(key);
  if (!existing || existing.resolvedTs !== null) return false;
  existing.resolvedTs = Date.now();
  if (repaired) existing.repaired = repaired;
  persist();
  return true;
}

/** Enregistre qu'une alerte a été émise pour cette anomalie (anti-spam). */
export function markNotified(key: string): void {
  ensureLoaded();
  const i = map.get(key);
  if (i && !i.notified) {
    i.notified = true;
    persist();
  }
}

/** Note l'auto-réparation appliquée à une anomalie active (sans la résoudre). */
export function markRepaired(key: string, repaired: string): void {
  ensureLoaded();
  const i = map.get(key);
  if (i) {
    i.repaired = repaired;
    persist();
  }
}

export function getIncident(key: string): Incident | undefined {
  ensureLoaded();
  return map.get(key);
}

export function activeIncidents(): Incident[] {
  ensureLoaded();
  return [...map.values()].filter((i) => i.resolvedTs === null).sort((a, b) => b.lastTs - a.lastTs);
}

export function recentIncidents(limitMs = 24 * 3600 * 1000): Incident[] {
  ensureLoaded();
  const cut = Date.now() - limitMs;
  return [...map.values()].filter((i) => i.lastTs >= cut).sort((a, b) => b.lastTs - a.lastTs);
}
