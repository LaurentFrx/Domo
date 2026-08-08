// See https://kit.svelte.dev/docs/types#app

import type { UserRole } from '$lib/server/users-store';

/** Identité résolue pour la requête en cours (cf. hooks.server.ts). */
interface AppUser {
  /** UUID du magasin, ou la sentinelle `'legacy'` pour une session anonyme
   *  antérieure à la phase identité. */
  id: string;
  /** `null` pour une session legacy : on ne sait pas qui c'est. */
  email: string | null;
  role: UserRole;
}

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Renseigné par `hooks.server.ts` sur les routes PROTÉGÉES uniquement.
       *  Absent sur /auth, /denied, les assets et les endpoints à Bearer
       *  (ticks systemd, portail) : ces chemins sortent avant le contrôle. */
      user?: AppUser;
    }
    // interface PageData {}
    // interface Platform {}
  }
}

export {};
