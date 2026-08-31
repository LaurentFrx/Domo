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
 *   `$components/… $theme/… $stores/… $utils/…` → les alias de svelte.config.js.
 *     Ils doivent rester EN PHASE avec ce fichier : un alias ajouté là et oublié
 *     ici ne casse rien au build, mais rend le test du module concerné
 *     inexécutable — c'est ce qui avait éteint `test:pilot` en silence.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const STUB_URL = 'domo-test:env-dynamic-private';
const SRC = path.resolve(import.meta.dirname, '..', 'src');

/** Miroir des alias de svelte.config.js (+ `$lib`, implicite dans SvelteKit). */
const ALIAS = {
  $lib: path.join(SRC, 'lib'),
  $components: path.join(SRC, 'lib', 'components'),
  $theme: path.join(SRC, 'lib', 'theme'),
  $stores: path.join(SRC, 'lib', 'stores'),
  $utils: path.join(SRC, 'lib', 'utils')
};

export async function resolve(specifier, context, next) {
  if (specifier === '$env/dynamic/private') {
    return { url: STUB_URL, shortCircuit: true };
  }
  for (const [alias, racine] of Object.entries(ALIAS)) {
    if (!specifier.startsWith(`${alias}/`)) continue;
    const base = path.join(racine, specifier.slice(alias.length + 1));
    const trouve = premierFichier(base);
    if (trouve) return { url: pathToFileURL(trouve).href, shortCircuit: true };
  }
  // Imports relatifs SANS extension : Vite et TypeScript les acceptent, l'ESM de
  // Node non. Sans cette résolution, un seul `from './x'` ajouté dans une chaîne
  // d'imports rend tout un fichier de tests inexécutable — et l'échec ressemble
  // à une panne du test, pas à une convention d'écriture.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    if (!fs.existsSync(base) || !fs.statSync(base).isFile()) {
      const trouve = premierFichier(base);
      if (trouve) return { url: pathToFileURL(trouve).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

/** Premier candidat existant parmi `base`, `base.ts`, `base/index.ts`. */
function premierFichier(base) {
  for (const candidat of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidat) && fs.statSync(candidat).isFile()) return candidat;
  }
  return null;
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
