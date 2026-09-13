/**
 * Revendication de contrôle de la Solarbank Max AC (mode Modbus « contrôle par un tiers »).
 *
 * POURQUOI. En mode 3 (`operating_mode = 3`), la Max AC **cesse totalement de
 * réguler** : mesuré le 13/09/2026, elle est passée de 670 W de charge à 0 W en
 * trente secondes et 684 W sont partis au réseau, en continu. Domo devient donc
 * indispensable en permanence — or il redémarre à chaque déploiement.
 *
 * Ce module ne pilote rien : il porte la seule chose que le chien de garde a
 * besoin de savoir, « Domo tient-il encore la barre ? ». La revendication
 * EXPIRE d'elle-même : un process mort ne peut pas mentir, il cesse simplement
 * de la renouveler. Le garde-fou vit sur le RPi4 (`ops/maxac-watchdog.py`) parce
 * que c'est justement la mort du VPS ou du service qu'il doit couvrir.
 */

/** Durée de validité d'une revendication. Au-delà, le chien de garde reprend la main. */
export const CLAIM_TTL_MS = 30_000;

let claimedUntil = 0;
let claimReason = '';

/** Appelé par la boucle de pilotage à CHAQUE écriture de consigne. */
export function claimMaxAcControl(reason: string): void {
  claimedUntil = Date.now() + CLAIM_TTL_MS;
  claimReason = reason;
}

/** Abandon explicite (arrêt propre de la boucle) : le garde-fou rend la main tout de suite. */
export function releaseMaxAcControl(): void {
  claimedUntil = 0;
  claimReason = 'abandon explicite';
}

export function maxAcClaim(): {
  controlling: boolean;
  expiresInMs: number;
  reason: string;
  ttlMs: number;
} {
  const left = claimedUntil - Date.now();
  return {
    controlling: left > 0,
    expiresInMs: Math.max(0, left),
    reason: left > 0 ? claimReason : 'aucune revendication',
    ttlMs: CLAIM_TTL_MS
  };
}
