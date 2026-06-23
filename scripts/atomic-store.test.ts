/**
 * Tests du socle de persistence durable/auto-réparante (atomic-store).
 * Lance : node --experimental-strip-types --test scripts/atomic-store.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../src/lib/server/atomic-store.ts';

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-'));
  return path.join(dir, 'state.json');
}

test('round-trip : écrit puis relit', async () => {
  const f = await tmpFile();
  await writeJsonAtomic(f, { a: 1, b: 'x' });
  const r = await readJsonSafe<Record<string, unknown>>(f, { fallback: () => ({}) });
  assert.deepEqual(r, { a: 1, b: 'x' });
});

test('fichier absent (ENOENT) → fallback silencieux', async () => {
  const f = await tmpFile();
  const r = await readJsonSafe(f, { fallback: () => ({ d: true }) });
  assert.deepEqual(r, { d: true });
});

test('2e écriture conserve la version N-1 en .bak', async () => {
  const f = await tmpFile();
  await writeJsonAtomic(f, { v: 1 });
  await writeJsonAtomic(f, { v: 2 });
  const bak = JSON.parse(await fs.readFile(`${f}.bak`, 'utf-8'));
  const cur = JSON.parse(await fs.readFile(f, 'utf-8'));
  assert.equal(bak.v, 1);
  assert.equal(cur.v, 2);
});

test('corruption → restauration automatique depuis .bak + quarantaine', async () => {
  const f = await tmpFile();
  await writeJsonAtomic(f, { v: 1 });
  await writeJsonAtomic(f, { v: 2 }); // .bak = {v:1}
  await fs.writeFile(f, '{ ceci nest pas du json', 'utf-8'); // casse le fichier courant
  const r = await readJsonSafe<{ v: number }>(f, { fallback: () => ({ v: -1 }), label: 'test' });
  assert.equal(r.v, 1); // restauré depuis la dernière bonne sauvegarde
  const files = await fs.readdir(path.dirname(f));
  assert.ok(
    files.some((n) => n.includes('.corrupt-')),
    'le fichier corrompu doit être mis en quarantaine'
  );
  // le fichier principal a été ré-établi (lecture suivante OK, sans erreur)
  const again = await readJsonSafe<{ v: number }>(f, { fallback: () => ({ v: -1 }) });
  assert.equal(again.v, 1);
});

test('corruption sans .bak → fallback (jamais un crash)', async () => {
  const f = await tmpFile();
  await fs.writeFile(f, '{{{ corrompu', 'utf-8');
  const r = await readJsonSafe(f, { fallback: () => ({ safe: true }), label: 'test2' });
  assert.deepEqual(r, { safe: true });
});

test('normalize est appliqué à la lecture', async () => {
  const f = await tmpFile();
  await writeJsonAtomic(f, { n: 5 });
  const r = await readJsonSafe<number>(f, {
    fallback: () => 0,
    normalize: (raw) => Number((raw as { n: number }).n) * 2
  });
  assert.equal(r, 10);
});
