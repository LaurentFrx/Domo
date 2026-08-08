/**
 * Hooks de résolution ESM : rendent `$env/dynamic/private` importable par
 * `node --test`, qui ne connaît évidemment pas les alias de SvelteKit.
 *
 * Le stub expose simplement `process.env` — le test pose donc ses variables
 * (AUTH_SECRET, AUTH_TOKEN) AVANT l'import dynamique du module testé. On teste
 * ainsi le VRAI `src/lib/server/auth.ts`, pas une réimplémentation qui
 * pourrait diverger sans qu'on le voie.
 */
const STUB_URL = 'domo-test:env-dynamic-private';

export async function resolve(specifier, context, next) {
  if (specifier === '$env/dynamic/private') {
    return { url: STUB_URL, shortCircuit: true };
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
