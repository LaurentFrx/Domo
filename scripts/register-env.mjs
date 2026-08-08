/**
 * Charge les hooks de résolution `$env/*` pour les tests exécutés hors Vite.
 * Usage : node --experimental-strip-types --import ./scripts/register-env.mjs --test scripts/<x>.test.ts
 */
import { register } from 'node:module';

register('./env-hooks.mjs', import.meta.url);
