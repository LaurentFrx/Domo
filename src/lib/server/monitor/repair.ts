/**
 * Auto-réparation — actions correctives SANS feu vert humain (mandat explicite).
 *
 * Strictement borné : commandes en LISTE BLANCHE, arguments fixes (jamais
 * d'entrée externe → pas d'injection shell, on passe par execFile sans shell),
 * et anti-rebond (cooldown) pour ne jamais entrer en boucle de redémarrage.
 *
 * Aujourd'hui : redémarrage du timer du recorder s'il est figé. Le redémarrage
 * passe par `sudo -n` (NOPASSWD vérifié pour systemctl sur ce VPS). Toute action
 * appliquée est journalisée et inscrite sur l'incident concerné.
 */
import { execFile } from 'node:child_process';
import { markRepaired } from './incidents';

const COOLDOWN_MS = 15 * 60 * 1000; // au plus une tentative / 15 min par action
const lastAttempt = new Map<string, number>();

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 12_000 }, (err) => {
      if (err) {
        console.error(`[repair] ${cmd} ${args.join(' ')} → échec: ${err.message}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * Tente de relancer l'enregistreur figé. Renvoie une description si une action a
 * été effectivement tentée avec succès, sinon null (cooldown actif ou échec).
 */
export async function repairRecorder(): Promise<string | null> {
  const key = 'recorder';
  const now = Date.now();
  if (now - (lastAttempt.get(key) ?? 0) < COOLDOWN_MS) return null;
  lastAttempt.set(key, now);
  const ok = await run('sudo', ['-n', 'systemctl', 'restart', 'domo-recorder.timer']);
  if (!ok) return null;
  const desc = 'Enregistreur relancé automatiquement (domo-recorder.timer)';
  markRepaired('recorder:stalled', desc);
  console.log(`[repair] ${desc}`);
  return desc;
}

/** Applique les réparations correspondant aux anomalies détectées. */
export async function autoRepair(summary: { recorderStalled: boolean }): Promise<string[]> {
  const done: string[] = [];
  if (summary.recorderStalled) {
    const r = await repairRecorder();
    if (r) done.push(r);
  }
  return done;
}
