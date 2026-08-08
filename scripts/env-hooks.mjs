/**
 * Hooks de résolution ESM : rendent les alias SvelteKit importables par
 * `node --test`, qui ne connaît évidemment pas le résolveur de Vite.
 *
 *   `$env/dynamic/private` → stub exposant `process.env`. Le test pose donc ses
 *     variables (AUTH_SECRET, AUTH_TOKEN) AVANT l'import dynamique du module
 *     testé. On teste ainsi le VRAI `src/lib/server/auth.ts`, pas une
 *     réimplémentation qui pourrait diverger sans qu'on le voie.
 *   `$lib/…` → `src/lib/…`, avec l'extension `.ts` ajoutée si elle manque —
 *     c'est ce qui permet de charger un `+server.ts` de route tel quel.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const STUB_URL = 'domo-test:env-dynamic-private';
const SRC_LIB = path.resolve(import.meta.dirname, '..', 'src', 'lib');

export async function resolve(specifier, context, next) {
  if (specifier === '$env/dynamic/private') {
    return { url: STUB_URL, shortCircuit: true };
  }
  if (specifier.startsWith('$lib/')) {
    const base = path.join(SRC_LIB, specifier.slice('$lib/'.length));
    for (const candidat of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidat) && fs.statSync(candidat).isFile()) {
        return { url: pathToFileURL(candidat).href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === STUB_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export const env = process.env;'
    };
  }
  return next(url, context);
}
